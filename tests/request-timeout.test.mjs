import assert from 'node:assert/strict';
import test from 'node:test';
import { withRequestTimeout } from '../js/request-timeout.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function withoutNative(t) {
  const original=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
  Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
  t.after(()=>Object.defineProperty(AbortSignal,'timeout',original));
}

test('request deadlines work without AbortSignal.timeout', async t => {
  const original=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
  Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
  t.after(()=>Object.defineProperty(AbortSignal,'timeout',original));
  const result=await withRequestTimeout(100,async signal=>{assert.equal(signal.aborted,false);return 'response';});
  assert.equal(result,'response');
});

test('fallback requests cancel their timer after success', async t => {
  withoutNative(t);
  let signal;
  assert.equal(await withRequestTimeout(10,async current=>{signal=current;return 42;}),42);
  await delay(30);assert.equal(signal.aborted,false);
});

test('fallback network failures retain their error and clean up the timer', async t => {
  withoutNative(t);
  const failure=new TypeError('network unavailable');let signal;
  await assert.rejects(withRequestTimeout(10,async current=>{signal=current;throw failure;}),error=>error===failure);
  await delay(30);assert.equal(signal.aborted,false);
});

test('an old-browser AbortError on deadline is normalized to TimeoutError', async t => {
  withoutNative(t);
  let signal;
  await assert.rejects(withRequestTimeout(10,current=>{
    signal=current;
    return new Promise((resolve,reject)=>current.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
  }),error=>error.name==='TimeoutError');
  assert.equal(signal.aborted,true);
});


test('modern browsers use their native timeout signal', async t => {
  const controller=new AbortController();let calls=0;
  t.mock.method(AbortSignal,'timeout',ms=>{calls++;assert.equal(ms,50);return controller.signal;});
  assert.equal(await withRequestTimeout(50,async signal=>{assert.equal(signal,controller.signal);return 'native';}),'native');
  assert.equal(calls,1);
});

test('native timeout implementations with AbortError are normalized consistently', async t => {
  const controller=new AbortController();
  t.mock.method(AbortSignal,'timeout',ms=>{setTimeout(()=>controller.abort(),ms);return controller.signal;});
  await assert.rejects(withRequestTimeout(10,signal=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
  })),error=>error.name==='TimeoutError');
});
