import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLiveServer, liveCapacityOptions } from '../server/live-server.mjs';
import { openRoomStore } from '../server/room-store.mjs';
import { ALL_HIDDEN } from '../js/live-visibility.js';
const state = round => ({ round, phase: 'done', slots: Array.from({ length: 5 }, (_, i) => ({ char: 'c'+i,
  build: { levels: { a: 1 }, used: 1, ultimates: [] }, ...(i===4 ? { trait: { name: 'secret' } } : {}) })) });
async function start(t, options = {}) {
  const server = createLiveServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  const base = 'http://127.0.0.1:'+server.address().port+'/lottery/live-api/rooms';
  const create = async () => (await (await fetch(base, { method: 'POST' })).json());
  const host = (room, method, path, body) => fetch(base+'/'+room.roomId+path, { method,
    headers: { Authorization: 'Bearer '+room.hostToken }, body: body === undefined ? undefined : JSON.stringify(body) });
  const enter = async (room, view) => {
    const res = await fetch(base+'/'+room.roomId+'/join', { method: 'POST', body: JSON.stringify({ view }) });
    assert.equal(res.status, 200); return (await res.json()).session;
  };
  const connect = (room, session) => fetch(base+'/'+room.roomId+'/events?session='+session);
  return { server, base, create, host, enter, connect };
}

test('spectators cannot consume the per-room or global player reserve', { timeout: 5000 }, async t => {
  const api = await start(t, { maxClients: 6, maxClientsPerRoom: 4, reservedPlayerConnections: 2, reservedPlayerConnectionsPerRoom: 2 });
  const rooms = [await api.create(), await api.create(), await api.create()];
  for (const room of rooms.slice(0,2)) for (let i=0;i<2;i++) assert.equal((await api.connect(room, await api.enter(room,'spectator'))).status,200);
  for (const room of [rooms[0],rooms[2]]) {
    const blocked=await api.connect(room, await api.enter(room,'spectator'));
    assert.equal(blocked.status,503);assert.equal((await blocked.json()).error,'spectator-capacity');
    assert.equal(blocked.headers.get('retry-after'),'3');
  }
  for(const view of ['hunter','survivor'])assert.equal((await api.connect(rooms[0],await api.enter(rooms[0],view))).status,200);
  assert.equal(api.server.metrics().connections,6);
  const full=await api.connect(rooms[2],await api.enter(rooms[2],'hunter'));
  assert.equal(full.status,503);assert.equal((await full.json()).error,'too-many-viewers');
});

test('two tabs count as one person, a third is refused, and another player still connects', async t => {
  const api=await start(t), room=await api.create(), token=await api.enter(room,'hunter');
  const a=await api.connect(room,token),b=await api.connect(room,token);
  assert.equal(a.status,200);assert.equal(b.status,200);
  const refused=await api.connect(room,token);assert.equal(refused.status,503);assert.equal((await refused.json()).error,'too-many-tabs');
  const status=await (await api.host(room,'GET','/status')).json();
  assert.equal(status.viewers.hunter,1);assert.equal(status.access.hunter.taken,1);
  assert.equal((await api.connect(room,await api.enter(room,'survivor'))).status,200);
});

test('concurrent joins and reconnects never oversubscribe a single seat', async t => {
  const api=await start(t),room=await api.create();
  await api.host(room,'PUT','/access',{view:'hunter',limit:1});
  const replies=await Promise.all(Array.from({length:20},()=>fetch(api.base+'/'+room.roomId+'/join',{method:'POST',body:JSON.stringify({view:'hunter'})})));
  assert.equal(replies.filter(r=>r.status===200).length,1);
  assert.equal(replies.filter(r=>r.status===409).length,19);
  const session=(await replies.find(r=>r.status===200).json()).session;
  const streams=await Promise.all(Array.from({length:8},()=>api.connect(room,session)));
  assert.equal(streams.filter(r=>r.status===200).length,2);
  assert.equal(streams.filter(r=>r.status===503).length,6);
});

test('one broadcast serializes once per view and permission changes invalidate the cache', async t => {
  const api=await start(t),room=await api.create();
  for(const view of ['hunter','survivor','spectator'])for(let i=0;i<4;i++)assert.equal((await api.connect(room,await api.enter(room,view))).status,200);
  const before=api.server.metrics().projections;
  await api.host(room,'PUT','/state',{seq:1,state:state(1)});
  assert.equal(api.server.metrics().projections-before,3);
  await api.host(room,'PUT','/visibility',{visibility:ALL_HIDDEN});
  assert.equal(api.server.metrics().projections-before,6);
  await api.host(room,'PUT','/state',{seq:2,state:state(2)});
  assert.equal(api.server.metrics().projections-before,9);
});

test('SQLite lock waits in the worker do not block HTTP status or main-thread timers', { timeout: 10000 }, async t => {
  const dir=await mkdtemp(join(tmpdir(),'pil-worker-lock-'));
  const dbPath=join(dir,'rooms.sqlite');
  const api=await start(t,{dbPath});
  const room=await api.create();
  const lock=new DatabaseSync(dbPath);lock.exec('BEGIN IMMEDIATE');
  let released=false;
  const began=performance.now();
  const release=setTimeout(()=>{lock.exec('COMMIT');released=true;},300);
  try {
    const writing=api.host(room,'PUT','/state',{seq:1,state:state(1)});
    const status=await api.host(room,'GET','/status');
    assert.equal(status.status,200);
    assert.ok(performance.now()-began<1500,'HTTP reads stalled behind SQLite');
    assert.equal((await writing).status,200);
    assert.ok(released);
    assert.ok(performance.now()-began<2500,'main event loop blocked by SQLite lock');
  } finally {
    clearTimeout(release);if(!released)lock.exec('ROLLBACK');lock.close();
    await api.server.shutdown();await rm(dir,{recursive:true,force:true});
  }
});

test('batch lease renewal commits together, preserves results and survives restart', async t => {
  const dir=await mkdtemp(join(tmpdir(),'pil-lease-batch-')), dbPath=join(dir,'rooms.sqlite');
  let time=1000000;
  const api=await start(t,{dbPath,now:()=>time,pingIntervalMs:100000});
  const ids=[];
  for(let i=0;i<3;i++){
    const room=await api.create();ids.push(room.roomId);
    await api.host(room,'PUT','/state',{seq:1,state:state(i+1)});
    assert.equal((await api.connect(room,await api.enter(room,'hunter'))).status,200);
  }
  time+=60000;
  await api.server.heartbeat();assert.equal(api.server.metrics().leaseBatches,1);
  const db=new DatabaseSync(dbPath,{readOnly:true});
  for(const row of db.prepare('SELECT * FROM rooms_v2').all()){
    assert.equal(row.touched_at,1000000);assert.equal(row.seq,1);
    assert.equal(JSON.parse(row.state).round,ids.indexOf(row.id)+1);
    assert.equal(Object.values(JSON.parse(row.seats))[0].expiresAt,time+120000);
  }
  db.close();await api.server.shutdown();
  const restarted=await start(t,{dbPath,now:()=>time,pingIntervalMs:100000});
  const loaded=new DatabaseSync(dbPath,{readOnly:true});
  assert.equal(loaded.prepare('SELECT count(*) AS n FROM rooms_v2').get().n,3);loaded.close();
  assert.equal(restarted.server.metrics().rooms,3);await restarted.server.shutdown();
  await rm(dir,{recursive:true,force:true});
});

test('capacity environment values are bounded and reservations cannot exceed total capacity',()=>{
  assert.deepEqual(liveCapacityOptions({LIVE_MAX_CLIENTS:'2000',LIVE_MAX_CONNECTIONS_PER_SESSION:'3'}),{maxClients:2000,maxConnectionsPerSession:3});
  for(const value of ['0','NaN','1.5','100001'])assert.throws(()=>liveCapacityOptions({LIVE_MAX_CLIENTS:value}));
  assert.throws(()=>liveCapacityOptions({LIVE_MAX_CLIENTS:'10',LIVE_RESERVED_PLAYER_CONNECTIONS:'11'}));
});


test('slow commits keep reads responsive, bound queued writes, and publish only committed state', { timeout: 5000 }, async t => {
  const real=openRoomStore();let release,started;
  const began=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});let hold=true;
  const api=await start(t,{maxPendingWrites:2,roomStore:{...real,async put(room){if(hold){started();await gate;hold=false;}real.put(room);}}});
  const room=await api.create();
  const first=api.host(room,'PUT','/state',{seq:1,state:state(1)});await began;
  const second=api.host(room,'PUT','/visibility',{visibility:ALL_HIDDEN});
  for(let i=0;i<50&&api.server.metrics().pendingWrites<2;i++)await new Promise(r=>setTimeout(r,2));
  const refused=await api.host(room,'PUT','/state',{seq:2,state:state(2)});
  assert.equal(refused.status,503);assert.equal((await refused.json()).error,'server-busy');
  assert.equal(refused.headers.get('retry-after'),'2');
  const before=await (await api.host(room,'GET','/status')).json();assert.notDeepEqual(before.visibility,ALL_HIDDEN);
  release();assert.equal((await first).status,200);assert.equal((await second).status,200);
  const after=await (await api.host(room,'GET','/status')).json();assert.deepEqual(after.visibility,ALL_HIDDEN);
  assert.equal(real.load(0)[0].state.round,1);
});
