// Outer protocol and persistence envelopes preserve the full supported depth of tool arguments.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkedReply, checkRequest } = require('../dist/model-validation');
const { encode, decode } = require('../dist/store');
function nested(count) {
  let value = { leaf: 'text' };
  for (let index = 0; index < count; index++) value = { child: value };
  return value;
}
test('depth-16 tool data survives reply, complete history and durable envelopes without widening the argument limit', () => {
  const reply = {
    text: 'working',
    calls: [{ id: 'one', name: 'echo', arguments: nested(15) }],
    stop: 'tools',
    model: 'fixture',
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null },
  };
  const checked = checkedReply(reply);
  assert.deepEqual(checked.calls[0].arguments, reply.calls[0].arguments);
  assert.doesNotThrow(() =>
    checkRequest({
      model: 'fixture',
      system: '',
      requestId: 'request',
      signal: new AbortController().signal,
      maxOutputTokens: 32,
      tools: [],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', reply: checked },
        {
          role: 'tool',
          callId: 'one',
          name: 'echo',
          result: { success: true, output: 'ok', data: nested(15) },
        },
      ],
    }),
  );
  const persisted = encode({ reply: checked }, 524288);
  assert.deepEqual(decode(persisted.json, persisted.hash, 524288), { reply: checked });
  assert.throws(
    () => checkedReply({ ...reply, calls: [{ ...reply.calls[0], arguments: nested(16) }] }),
    /nesting/,
  );
});
