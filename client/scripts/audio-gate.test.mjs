import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const code = readFileSync(new URL('../src/audio/vadGateWorklet.js', import.meta.url), 'utf8');
function gate(rate = 48000) {
  let Constructor;
  runInNewContext(code, {
    sampleRate: rate, Float32Array, Math, Number,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage() {} }; },
    registerProcessor: (_, cls) => { Constructor = cls; },
  });
  const node = new Constructor();
  node.port.onmessage({data:{openThresholdDb:-52,closeThresholdDb:-58,holdMs:300}});
  return node;
}
function render(node, values, block = 128) {
  const result = new Float32Array(values.length);
  for (let at=0; at<values.length; at+=block) {
    const input = values.subarray(at,at+block);
    const output = new Float32Array(input.length);
    node.process([[input]], [[output]]);
    result.set(output,at);
  }
  return result;
}
for (const rate of [16000,48000]) {
  test(`gate ${rate}: silence, lookahead, hold and complete release`, () => {
    const node=gate(rate);
    const quiet=render(node,new Float32Array(rate/10).fill(.0001));
    assert.ok(quiet.every(x=>x===0));
    const speech=render(node,new Float32Array(rate/10).fill(.02));
    const first=speech.findIndex(x=>x>.01);
    assert.ok(Math.abs(first-rate*.01)<=1, `lookahead onset=${first}`);
    const tail=render(node,new Float32Array(rate*.5).fill(.0001));
    assert.ok(tail[Math.floor(rate*.2)]>0, 'hold protects trailing speech');
    assert.ok(tail.subarray(Math.floor(rate*.42)).every(x=>x===0),'release reaches exact silence');
  });
}
test('disabled gate preserves samples without delay and can be enabled again',()=>{
  const node=gate();
  node.port.onmessage({data:{disabled:true}});
  const input=Float32Array.from({length:384},(_,i)=>Math.sin(i/11)*.04);
  assert.deepEqual(render(node,input),input);
  node.port.onmessage({data:{openThresholdDb:-52,closeThresholdDb:-58,holdMs:300}});
  const quiet=render(node,new Float32Array(48000).fill(.0001));
  assert.ok(quiet.subarray(24000).every(x=>x===0));
});
test('timing does not depend on rendering quantum and non-finite input cannot poison RMS',()=>{
  const signal=Float32Array.from({length:48000},(_,i)=>i<4800?.02:.0001);
  assert.deepEqual(render(gate(),signal,128),render(gate(),signal,256));
  const node=gate();
  const invalid=new Float32Array(128).fill(NaN);
  assert.ok(render(node,invalid).every(Number.isFinite));
  assert.ok(render(node,new Float32Array(4800).fill(.02)).some(x=>x>.01));
});
