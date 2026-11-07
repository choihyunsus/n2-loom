// Real loopback streaming transports drive the complete public dialogue and its durable Hecaton tool turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { setup, tool } = require('./runtime-helpers.cjs');
const { factories, fixture, encode } = require('./provider-fixtures.cjs');
for (const kind of Object.keys(factories)) {
  test(`public Loom with ${kind} streams HTTP, executes a tool and replays opaque continuation exactly`, async (t) => {
    const requests = [];
    const server = http
      .createServer(async (request, response) => {
        let data = '';
        for await (const bytes of request) data += bytes;
        requests.push(JSON.parse(data));
        response.writeHead(200, {
          'content-type': kind === 'ollama' ? 'application/x-ndjson' : 'text/event-stream',
        });
        const bytes = Buffer.from(
          encode(
            kind,
            fixture(
              kind,
              requests.length === 1 ? 'Working😀' : 'Finished😀',
              requests.length === 1,
            ),
          ),
        );
        for (let start = 0; start < bytes.length; start += 17)
          response.write(bytes.subarray(start, start + 17));
        response.end();
      })
      .listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const provider = factories[kind]({
      id: kind,
      model: 'fixture',
      apiKey: 'fixture-secret',
      endpoint: `http://127.0.0.1:${server.address().port}/model`,
      retries: 0,
    });
    let effects = 0;
    const s = setup(t, {
      provider,
      tools: [
        tool({
          name: 'echo',
          readOnly: true,
          execute(args) {
            effects++;
            assert.equal(args.text, '한글😀');
            return { success: true, output: 'Observed tool bytes' };
          },
        }),
      ],
    });
    const events = [];
    const result = await s.runtime.run(s.request, {
      onEvent(event) {
        events.push(event);
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.output, 'Finished😀');
    assert.equal(effects, 1);
    assert.equal(requests.length, 2);
    assert.equal(result.budget.modelRequests, 2);
    assert.equal(result.budget.toolCalls, 1);
    assert.equal(
      events
        .filter((event) => event.type === 'delta' && event.data.turn === 1)
        .map((event) => event.data.text)
        .join(''),
      'Finished😀',
    );
    assert.match(JSON.stringify(requests[1]), /Observed tool bytes/);
    assert.match(JSON.stringify(requests[1]), /opaque-fixture|private-fixture/);
    assert.doesNotMatch(JSON.stringify(events), /opaque-fixture|private-fixture|fixture-secret/);
    assert.doesNotMatch(JSON.stringify(s.runtime.status('one')), /fixture-secret/);
    await s.runtime.close();
    const restarted = s.reopen();
    assert.equal((await restarted.run(s.request)).cached, true);
    assert.equal(requests.length, 2);
    assert.equal(effects, 1);
  });
}
