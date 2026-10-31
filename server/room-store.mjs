import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// One writer per database. Commit before changing the in-memory room or publishing it.
export function openRoomStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    if (path !== ':memory:') chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Unsupported room database version');
    db.exec(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, host_token TEXT NOT NULL, tokens TEXT NOT NULL,
      state TEXT NOT NULL, visibility TEXT NOT NULL,
      seq INTEGER NOT NULL, touched_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(touched_at);
    PRAGMA user_version = 1;`);
    const upsert = db.prepare(`INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET host_token=excluded.host_token, tokens=excluded.tokens,
      state=excluded.state, visibility=excluded.visibility, seq=excluded.seq, touched_at=excluded.touched_at`);
    const remove = db.prepare('DELETE FROM rooms WHERE id = ?');
    return {
      load(cutoff) {
        db.prepare('DELETE FROM rooms WHERE touched_at < ?').run(cutoff);
        return db.prepare('SELECT * FROM rooms').all().map(row => ({
          id: row.id, hostToken: row.host_token, tokens: JSON.parse(row.tokens),
          state: JSON.parse(row.state), visibility: JSON.parse(row.visibility),
          seq: row.seq, touchedAt: row.touched_at,
        }));
      },
      put(room) {
        upsert.run(room.id, room.hostToken, JSON.stringify(room.tokens), JSON.stringify(room.state),
          JSON.stringify(room.visibility), room.seq, room.touchedAt);
      },
      remove(id) { remove.run(id); },
      check() { db.prepare('SELECT 1').get(); },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
