import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayerSessions } from '../js/live-session.js';
const memory = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
const response = (status = 200, error) => ({ status, ok: status >= 200 && status < 300, json: async () => ({ error }) });
const prepare = options => {
  const sessions = createPlayerSessions(options);
  sessions.save('123456', { session: 'old-session', view: 'hunter' });
  sessions.beginLeave('123456', 'old-session', 'hunter');
  return sessions;
};

test('failed exit keeps credentials and the pending receipt across reload, then retry clears both', async () => {
  const storage=memory();let status=503;
  const request=async()=>response(status);
  let sessions=prepare({storage,request});
  await assert.rejects(sessions.release('123456','old-session'),/503/);
  assert.equal(sessions.isLeaving('123456'),false);
  sessions=createPlayerSessions({storage,request});
  assert.deepEqual(sessions.load('123456'),{session:'old-session',view:'hunter'});
  assert.deepEqual(sessions.pending('123456'),{session:'old-session',view:'hunter'});
  status=200;await sessions.release('123456','old-session');
  assert.equal(sessions.load('123456'),null);assert.equal(sessions.pending('123456'),null);
});

test('a network failure retains the same exit receipt for retry', async () => {
  const sessions=prepare({storage:memory(),request:async()=>{throw new TypeError('network');}});
  await assert.rejects(sessions.release('123456','old-session'),/network/);
  assert.equal(sessions.load('123456').session,'old-session');assert.equal(sessions.pending('123456').session,'old-session');
});

test('a hanging exit request times out without deleting the recoverable session', async () => {
  const keepAlive=setTimeout(()=>{},1000);
  try {
    const sessions=prepare({storage:memory(),requestTimeoutMs:10,request:(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
    await assert.rejects(sessions.release('123456','old-session'),error=>error.name==='TimeoutError');
    assert.equal(sessions.pending('123456').session,'old-session');assert.equal(sessions.isLeaving('123456'),false);
  } finally { clearTimeout(keepAlive); }
});

test('only a confirmed missing room, not a missing route or proxy error, clears an exit', async () => {
  const storage=memory();let error='not-found';
  const sessions=prepare({storage,request:async()=>response(404,error)});
  await assert.rejects(sessions.release('123456','old-session'),/404/);
  assert.equal(sessions.load('123456').session,'old-session');
  error='room-not-found';await sessions.release('123456','old-session');
  assert.equal(sessions.load('123456'),null);assert.equal(sessions.pending('123456'),null);
});

test('a delayed exit acknowledgement cannot remove a newer active identity or pending exit', async () => {
  const storage=memory();let resolve;
  const sessions=prepare({storage,request:()=>new Promise(r=>{resolve=r;})});
  const old=sessions.release('123456','old-session');
  const otherTab=createPlayerSessions({storage});
  otherTab.save('123456',{session:'new-session',view:'survivor'});
  otherTab.beginLeave('123456','new-session','survivor');
  resolve(response());await old;
  assert.equal(sessions.load('123456').session,'new-session');assert.equal(sessions.pending('123456').session,'new-session');
});

test('duplicate retries share one request and separate rooms remain independent', async () => {
  let calls=0,finish;const requests=[];
  const sessions=prepare({storage:memory(),request:(url,options)=>{calls++;requests.push({url,options});return new Promise(r=>{finish=r;});}});
  const a=sessions.release('123456','old-session'),b=sessions.release('123456','old-session');
  assert.equal(a,b);assert.equal(calls,1);assert.equal(sessions.isLeaving('123456'),true);assert.equal(sessions.isLeaving('654321'),false);
  assert.equal(requests[0].options.keepalive,true);assert.deepEqual(JSON.parse(requests[0].options.body),{session:'old-session'});
  finish(response());await a;assert.equal(sessions.isLeaving('123456'),false);
});

test('successful replacement can clear the old exit without removing its newly saved session', () => {
  const sessions=prepare({storage:memory()});
  sessions.save('123456',{session:'replacement',view:'hunter'});
  sessions.forget('123456','old-session');
  assert.equal(sessions.load('123456').session,'replacement');assert.equal(sessions.pending('123456'),null);
});

test('blocked browser storage still permits in-page recovery without throwing', async () => {
  const storage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){throw Error('blocked');}};
  const sessions=prepare({storage,request:async()=>response()});
  assert.equal(sessions.pending('123456').session,'old-session');
  await sessions.release('123456','old-session');assert.equal(sessions.load('123456'),null);assert.equal(sessions.pending('123456'),null);
});


test('older Safari can release a pending exit without AbortSignal.timeout', async t => {
  const original=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
  Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
  t.after(()=>Object.defineProperty(AbortSignal,'timeout',original));
  let calls=0;
  const sessions=prepare({storage:memory(),request:async(_url,options)=>{calls++;assert.equal(options.signal.aborted,false);return response();}});
  await sessions.release('123456','old-session');assert.equal(calls,1);
  assert.equal(sessions.load('123456'),null);assert.equal(sessions.pending('123456'),null);
});
