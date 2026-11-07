// Read real streamed bytes before completion and preserve cancellation, retry and diagnostic boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { streamTransport, checkedEndpoint, credential } = require('../dist/stream-http');
function request(signal = new AbortController().signal) {
  return { signal, requestId: 'fixture' };
}
async function serve(t, handler) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/model`;
}
test('SSE text reaches the consumer before the final frame and cancellation closes the actual HTTP stream', async (t) => {
  let release, received, closed;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const early = new Promise((resolve) => {
    received = resolve;
  });
  const disconnected = new Promise((resolve) => {
    closed = resolve;
  });
  const endpoint = await serve(t, async (_req, res) => {
    res.on('close', closed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    await waiting;
    if (!res.destroyed) res.end('data: done\n\n');
  });
  const controller = new AbortController(),
    events = [];
  const transport = streamTransport(endpoint, {}, { id: 'fixture', model: 'fixture', retries: 0 });
  const pending = transport({}, request(controller.signal), 'sse', async (frame) => {
    events.push(frame);
    received();
    return frame === 'done';
  });
  await early;
  assert.deepEqual(events, ['first']);
  controller.abort(new Error('owned cancellation'));
  await assert.rejects(pending, /owned cancellation/);
  await disconnected;
  release();
});
test('only eligible HTTP failures retry and a lost response after streamed data never replays the POST', async (t) => {
  let requests = 0;
  const endpoint = await serve(t, (_req, res) => {
    requests++;
    if (requests === 1) {
      res.writeHead(503, { 'retry-after': '0' }).end('fixture-private-token');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end('{"done":true}');
  });
  let attempts = 0;
  await streamTransport(endpoint, {}, { id: 'fixture', model: 'fixture', retries: 1 })(
    {},
    { ...request(), onAttempt: () => attempts++ },
    'ndjson',
    async (frame) => JSON.parse(frame).done,
  );
  assert.equal(requests, 2);
  assert.equal(attempts, 2);
  let partialRequests = 0;
  const partial = await serve(t, (_req, res) => {
    partialRequests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: partial\n\n');
  });
  await assert.rejects(
    streamTransport(partial, {}, { id: 'fixture', model: 'fixture', retries: 2 })(
      {},
      request(),
      'sse',
      async () => false,
    ),
    /before_completion/,
  );
  assert.equal(partialRequests, 1);
});
test('provider errors and invalid wire data stay bounded and redact server bodies and endpoints', async (t) => {
  const cases = [
    [401, 'text/plain', 'fixture-private-token'],
    [200, 'text/html', 'fixture-private-token'],
    [200, 'text/event-stream', Buffer.from([0xc3, 0x28])],
    [302, 'text/plain', 'fixture-private-token'],
  ];
  for (const [status, type, body] of cases) {
    const endpoint = await serve(t, (_req, res) =>
      res.writeHead(status, { 'content-type': type, location: 'https://example.com/' }).end(body),
    );
    await assert.rejects(
      streamTransport(endpoint, {}, { id: 'fixture', model: 'fixture', retries: 0 })(
        {},
        request(),
        'sse',
        async () => false,
      ),
      (error) => {
        assert.doesNotMatch(String(error), /fixture-private-token|127\.0\.0\.1|example\.com/);
        return true;
      },
    );
  }
  assert.throws(() => checkedEndpoint('https://user:secret@example.com/model'));
  assert.throws(() => checkedEndpoint('http://example.com/model'));
  assert.throws(() => credential('secret\r\nInjected: true'));
});
test('total deadlines interrupt an uncooperative stream consumer callback', async (t) => {
  const endpoint = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  });
  const started = Date.now();
  await assert.rejects(
    streamTransport(endpoint, {}, { id: 'fixture', model: 'fixture', timeoutMs: 50 })(
      {},
      request(),
      'sse',
      async () => new Promise(() => {}),
    ),
    /timeout/,
  );
  assert.ok(Date.now() - started < 3000);
  await delay(10);
});

test('a host attempt-budget rejection survives transport redaction and prevents the POST', async (t) => {
  let calls = 0;
  const endpoint = await serve(t, (_request, response) => {
    calls++;
    response.writeHead(500).end();
  });
  const rejected = new Error('Owned model request budget exhausted');
  await assert.rejects(
    streamTransport(endpoint, {}, { id: 'fixture', model: 'fixture' })(
      {},
      {
        ...request(),
        onAttempt: () => {
          throw rejected;
        },
      },
      'sse',
      async () => false,
    ),
    (error) => error === rejected,
  );
  assert.equal(calls, 0);
});
