import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// One writer per database. Commit before changing memory or publishing.
// Keep the v1 schema and user_version readable by the deployed rollback runtime.
// Room-number sessions live in their own table; old link tokens are never imported.
export function openRoomStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    if (path !== ':memory:') chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error('Unsupported room database version');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Preserve databases created by the unreleased v2 preview as well.
      if (version === 2) db.exec('ALTER TABLE rooms RENAME TO rooms_v2; DROP INDEX IF EXISTS rooms_expiry;');
      db.exec(`CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, host_token TEXT NOT NULL, tokens TEXT NOT NULL,
        state TEXT NOT NULL, visibility TEXT NOT NULL,
        seq INTEGER NOT NULL, touched_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(touched_at);
      CREATE TABLE IF NOT EXISTS rooms_v2 (
        id TEXT PRIMARY KEY, host_token TEXT NOT NULL, access TEXT NOT NULL, seats TEXT NOT NULL,
        state TEXT NOT NULL, visibility TEXT NOT NULL,
        seq INTEGER NOT NULL, touched_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS rooms_v2_expiry ON rooms_v2(touched_at);
      PRAGMA user_version = 1;
      COMMIT;`);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const insert = db.prepare('INSERT INTO rooms_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const update = db.prepare(`UPDATE rooms_v2 SET host_token=?, access=?, seats=?, state=?, visibility=?, seq=?, touched_at=? WHERE id=?`);
    const remove = db.prepare('DELETE FROM rooms_v2 WHERE id = ?');
    const updateSeats = db.prepare('UPDATE rooms_v2 SET seats=? WHERE id=?');
    const values = room => [room.hostToken, JSON.stringify(room.access), JSON.stringify(room.seats), JSON.stringify(room.state),
      JSON.stringify(room.visibility), room.seq, room.touchedAt];
    return {
      load(cutoff) {
        db.prepare('DELETE FROM rooms_v2 WHERE touched_at < ?').run(cutoff);
        return db.prepare('SELECT * FROM rooms_v2').all().map(row => ({
          id: row.id, hostToken: row.host_token, access: JSON.parse(row.access),
          // Preview seats had no durable lease. They may reclaim a free seat,
          // but must not receive a new grace period merely because we restarted.
          seats: Object.fromEntries(Object.entries(JSON.parse(row.seats)).map(([hash, seat]) =>
            [hash, typeof seat === 'string' ? { view: seat, expiresAt: 0 } : seat])),
          state: JSON.parse(row.state), visibility: JSON.parse(row.visibility),
          seq: row.seq, touchedAt: row.touched_at,
        }));
      },
      create(room) { insert.run(room.id, ...values(room)); },
      put(room) {
        if (update.run(...values(room), room.id).changes !== 1) throw new Error('Room no longer exists');
      },
      putSeats(id, seats) {
        if (updateSeats.run(JSON.stringify(seats), id).changes !== 1) throw new Error('Room no longer exists');
      },
      // All active rooms renew in one durable transaction. Never rewrite results
      // or touched_at just to renew a player lease.
      renewSeats(updates) {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const { id, seats } of updates) {
            if (updateSeats.run(JSON.stringify(seats), id).changes !== 1) throw new Error('Room no longer exists');
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      remove(id) { remove.run(id); },
      check() { db.prepare('SELECT 1').get(); },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}


const workerMethods = ['create', 'put', 'putSeats', 'renewSeats', 'remove', 'check'];

// Startup migration/loading happens before listen(). Once serving requests,
// SQLite and fsync run on one worker, leaving HTTP and SSE responsive.
export function openWorkerRoomStore(path = ':memory:') {
  let worker, failure, closing, nextId = 0;
  const pending = new Map();
  function fail(error) {
    failure = error;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  }
  function call(method, args = []) {
    if (failure) return Promise.reject(failure);
    if (!worker || closing) return Promise.reject(new Error('Room store is closed'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });
  }
  return {
    load(cutoff) {
      const bootstrap = openRoomStore(path);
      let rooms;
      try { rooms = bootstrap.load(cutoff); } finally { bootstrap.close(); }
      worker = new Worker(new URL(import.meta.url), { workerData: { roomStorePath: path }, execArgv: [] });
      worker.on('message', ({ id, error, result }) => {
        const waiter = pending.get(id);
        if (!waiter) return;
        pending.delete(id);
        if (error) waiter.reject(new Error(error));
        else waiter.resolve(result);
      });
      worker.on('error', fail);
      worker.on('exit', code => {
        if (!closing || code !== 0) fail(new Error('Room store worker exited'));
      });
      return rooms;
    },
    ...Object.fromEntries(workerMethods.map(method => [method, (...args) => call(method, args)])),
    close() {
      if (closing) return closing;
      if (!worker) return Promise.resolve();
      const stopping = call('close').catch(() => {}).then(() => worker.terminate());
      closing = stopping;
      return stopping;
    },
  };
}

if (!isMainThread && workerData?.roomStorePath !== undefined) {
  const store = openRoomStore(workerData.roomStorePath);
  parentPort.on('message', ({ id, method, args }) => {
    try {
      if (method !== 'close' && !workerMethods.includes(method)) throw new Error('Invalid store operation');
      const result = store[method](...args);
      parentPort.postMessage({ id, result });
      if (method === 'close') parentPort.close();
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
}
