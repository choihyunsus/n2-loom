// Test exact Unicode and SSE framing against every byte split before adding provider aggregation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamFrames } = require('../dist/stream-frames');
test('SSE preserves every UTF-8 split and CR/LF split with multiline data', () => {
  const bytes = Buffer.from('event: sample\r\ndata:{"a":"한글😀",\r\ndata: "b":1}\r\n\r\n');
  for (let split = 0; split <= bytes.length; split++) {
    const frames = new StreamFrames('sse');
    const results = [
      ...frames.push(bytes.subarray(0, split)),
      ...frames.push(bytes.subarray(split)),
      ...frames.finish(),
    ];
    assert.deepEqual(results.map(JSON.parse), [{ a: '한글😀', b: 1 }]);
  }
});
test('NDJSON accepts a terminal line without newline and rejects malformed UTF-8 or oversized frames', () => {
  const frames = new StreamFrames('ndjson');
  assert.deepEqual(
    [...frames.push(Buffer.from('{"text":"한글😀"}\n{"done":true}')), ...frames.finish()].map(
      JSON.parse,
    ),
    [{ text: '한글😀' }, { done: true }],
  );
  assert.throws(() => new StreamFrames('ndjson').push(Buffer.from([0xc3, 0x28])));
  assert.throws(() => new StreamFrames('ndjson').push(Buffer.alloc(2097153, 32)), /2 MiB/);
  const partial = new StreamFrames('sse');
  partial.push(Buffer.from('data: incomplete'));
  assert.throws(() => partial.finish(), /inside a frame/);
});
test('SSE handles comment-only events and independently bounded consecutive frames', () => {
  const frames = new StreamFrames('sse');
  assert.deepEqual(frames.push(Buffer.from(': keepalive\n\ndata: first\n\ndata:second\n\n')), [
    'first',
    'second',
  ]);
  assert.deepEqual(frames.finish(), []);
  const text = 'a'.repeat(1100000);
  assert.deepEqual(new StreamFrames('sse').push(Buffer.from(`data:${text}\n\ndata:${text}\n\n`)), [
    text,
    text,
  ]);
  const carriage = new StreamFrames('sse');
  assert.deepEqual(carriage.push(Buffer.from('data: first\r')), []);
  assert.deepEqual(carriage.push(Buffer.from('data: second\n\n')), ['first\nsecond']);
});
