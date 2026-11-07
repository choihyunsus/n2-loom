// Provider factories consume real HTTP streams, preserve continuation and reject incomplete tool protocols.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { factories, fixture, encode } = require('./provider-fixtures.cjs');

const tool = {
  name: 'echo',
  description: 'Return text',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};
const request = (overrides = {}) => ({
  model: 'fixture',
  system: 'Fixture instructions',
  messages: [{ role: 'user', content: 'Hello' }],
  tools: [tool],
  maxOutputTokens: 32,
  requestId: 'request',
  signal: new AbortController().signal,
  ...overrides,
});
async function provider(t, kind, makeEvents, options = {}) {
  const requests = [],
    headers = [];
  const server = http
    .createServer(async (req, res) => {
      let body = '';
      for await (const bytes of req) body += bytes;
      requests.push(JSON.parse(body));
      headers.push(req.headers);
      res.writeHead(200, {
        'content-type': kind === 'ollama' ? 'application/x-ndjson' : 'text/event-stream',
      });
      const buffer = Buffer.from(encode(kind, makeEvents(requests.length)));
      for (let start = 0; start < buffer.length; start += 17)
        res.write(buffer.subarray(start, start + 17));
      res.end();
    })
    .listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const result = factories[kind]({
    id: kind,
    model: 'fixture',
    apiKey: 'fixture-private-key',
    endpoint: `http://127.0.0.1:${server.address().port}/model`,
    retries: 0,
    ...options,
  });
  return { result, requests, headers };
}
for (const kind of Object.keys(factories)) {
  test(`${kind} streams exact Unicode, keeps opaque continuation and reports cumulative usage`, async (t) => {
    const { result: engine, requests, headers } = await provider(t, kind, () => fixture(kind));
    const deltas = [];
    const reply = await engine.stream(request(), (delta) => {
      deltas.push(delta);
    });
    assert.equal(reply.text, '한글😀');
    assert.equal(reply.stop, 'complete');
    assert.equal(deltas.join(''), reply.text);
    assert.equal(deltas.length, 3);
    assert.equal(engine.textStreaming, true);
    assert.deepEqual(reply.usage, {
      inputTokens: kind === 'messages' ? 15 : 10,
      outputTokens: kind === 'interactions' ? 7 : 5,
      cachedInputTokens: 3,
    });
    assert.equal(requests[0].stream, true);
    assert.doesNotMatch(JSON.stringify(engine), /fixture-private-key/);
    assert.doesNotMatch(JSON.stringify(requests), /fixture-private-key/);
    assert.doesNotMatch(deltas.join(''), /private-fixture|opaque-fixture/);
    assert.match(JSON.stringify(reply.providerState), /private-fixture|opaque-fixture/);
    if (kind === 'messages') assert.equal(headers[0]['anthropic-version'], '2026-10-21');
  });
  test(`${kind} assembles tool arguments and sends the exact saved continuation with adjacent tool results`, async (t) => {
    const { result: engine, requests } = await provider(t, kind, (count) =>
      fixture(kind, count === 1 ? 'Working' : 'Finished', count === 1),
    );
    const first = await engine.generate(request());
    assert.equal(first.stop, 'tools');
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].name, 'echo');
    assert.deepEqual(first.calls[0].arguments, { text: '한글😀' });
    const next = await engine.generate(
      request({
        requestId: 'next',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', reply: first },
          {
            role: 'tool',
            callId: first.calls[0].id,
            name: first.calls[0].name,
            result: { success: true, output: 'real result' },
          },
        ],
      }),
    );
    assert.equal(next.stop, 'complete');
    assert.equal(next.text, 'Finished');
    assert.match(JSON.stringify(requests[1]), /real result/);
    assert.match(JSON.stringify(requests[1]), /opaque-fixture|private-fixture/);
  });
  test(`${kind} preserves an explicit token-limit outcome and rejects a stream without a terminal event`, async (t) => {
    const first = await provider(t, kind, () => fixture(kind, 'Partial', false, 'incomplete'));
    assert.equal((await first.result.generate(request())).stop, 'incomplete');
    const second = await provider(t, kind, () => fixture(kind).slice(0, -1));
    await assert.rejects(second.result.generate(request()), /before_completion/);
  });
}
test('Ollama JSON envelope emits decoded text after validation and declares its text buffering', async (t) => {
  const text = JSON.stringify({ text: '한글😀', calls: [] });
  const { result: engine, requests } = await provider(t, 'ollama', () => fixture('ollama', text), {
    toolMode: 'json',
  });
  const deltas = [];
  const reply = await engine.stream(request(), (delta) => {
    deltas.push(delta);
  });
  assert.equal(engine.textStreaming, false);
  assert.equal(reply.text, '한글😀');
  assert.deepEqual(deltas, ['한글😀']);
  assert.equal(requests[0].format.type, 'object');
});
test('plain user/assistant history synthesizes native text continuation without fabricating old tool calls', async (t) => {
  for (const kind of Object.keys(factories)) {
    const { result: engine, requests } = await provider(t, kind, () => fixture(kind));
    await engine.generate(
      request({
        messages: [
          { role: 'user', content: 'Earlier' },
          {
            role: 'assistant',
            reply: {
              text: 'Historical answer',
              calls: [],
              stop: 'complete',
              model: 'history',
              usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null },
            },
          },
          { role: 'user', content: 'Follow-up' },
        ],
      }),
    );
    assert.match(JSON.stringify(requests[0]), /Historical answer/);
  }
});
test('stream final text mismatch and malformed tool arguments fail before a normalized successful reply', async (t) => {
  const first = await provider(t, 'responses', () => {
    const events = fixture('responses');
    events.at(-1).response.output[1].content[0].text = 'different';
    return events;
  });
  await assert.rejects(first.result.generate(request()), /stream_text_mismatch/);
  const second = await provider(t, 'messages', () => {
    const events = fixture('messages', '', true);
    events.find((event) => event.delta?.type === 'input_json_delta').delta.partial_json = 'broken';
    return events;
  });
  await assert.rejects(second.result.generate(request()), /invalid_or_interrupted_stream/);
});
test('Ollama preserves distinct upstream IDs even when streamed function indices repeat and binds result IDs', async (t) => {
  const { result: engine, requests } = await provider(t, 'ollama', (count) => {
    const events = fixture('ollama', count === 1 ? 'Working' : 'Finished');
    if (count === 1)
      events.splice(
        -1,
        0,
        ...['call-a', 'call-b'].map((id) => ({
          model: 'fixture',
          done: false,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id, function: { index: 0, name: 'echo', arguments: { text: 'same' } } }],
          },
        })),
      );
    return events;
  });
  const first = await engine.generate(request());
  assert.deepEqual(
    first.calls.map((call) => call.id),
    ['call-a', 'call-b'],
  );
  const messages = [
    { role: 'user', content: 'Perform both requested reads' },
    { role: 'assistant', reply: first },
    ...first.calls.map((call) => ({
      role: 'tool',
      callId: call.id,
      name: call.name,
      metadata: call.metadata,
      result: { success: true, output: 'observed' },
    })),
  ];
  await engine.generate(request({ messages }));
  assert.deepEqual(
    requests[1].messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id),
    ['call-a', 'call-b'],
  );
  const changed = structuredClone(messages);
  changed[2].metadata.ollamaCallId = 'wrong';
  await assert.rejects(engine.generate(request({ messages: changed })), /conflicts/);
  assert.equal(requests.length, 2);
});
test('Ollama rejects repeated upstream call IDs before returning executable tool calls', async (t) => {
  const { result: engine } = await provider(t, 'ollama', () => {
    const events = fixture('ollama', 'Working');
    const call = {
      id: 'duplicate',
      function: { index: 0, name: 'echo', arguments: { text: 'same' } },
    };
    events.splice(-1, 0, {
      model: 'fixture',
      done: false,
      message: { role: 'assistant', content: '', tool_calls: [call, call] },
    });
    return events;
  });
  await assert.rejects(engine.generate(request()), /invalid_or_interrupted_stream/);
});
test('Ollama continues older saved synthetic-ID history through its legacy tool-name contract', async (t) => {
  const { result: engine, requests } = await provider(t, 'ollama', (count) => {
    const events = fixture('ollama', count === 1 ? 'Working' : 'Finished', count === 1);
    if (count === 1)
      events.find((event) => event.message?.tool_calls?.length).message.tool_calls[0].id =
        'upstream-old';
    return events;
  });
  const first = await engine.generate(request());
  first.calls[0].id = 'call_legacy_saved';
  delete first.calls[0].metadata;
  const final = await engine.generate(
    request({
      messages: [
        { role: 'user', content: 'Continue saved work' },
        { role: 'assistant', reply: first },
        {
          role: 'tool',
          callId: first.calls[0].id,
          name: first.calls[0].name,
          result: { success: true, output: 'saved result' },
        },
      ],
    }),
  );
  assert.equal(final.stop, 'complete');
  const sent = requests[1].messages.find((message) => message.role === 'tool');
  assert.equal(sent.tool_name, 'echo');
  assert.equal(Object.hasOwn(sent, 'tool_call_id'), false);
});
