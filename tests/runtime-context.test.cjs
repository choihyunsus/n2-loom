// Long dialogues preserve scoped evidence and cumulative limits while shortening only model context.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Provider, reply, setup, tool, toolReply } = require('./runtime-helpers.cjs');
const { inspectLoom } = require('../dist/library');
test('context handoffs preserve source links and cumulative model/tool budgets through multiple generations', async (t) => {
  const requests = [];
  const provider = new Provider((request, count) => {
    requests.push(request);
    assert.ok(Object.isFrozen(request.messages));
    assert.ok(Object.isFrozen(request.tools));
    return count < 3
      ? toolReply('fixture_read', { text: String(count) })
      : reply('Completed after handoffs');
  });
  const s = setup(t, {
    provider,
    limits: { contextBytes: 4096, maxGenerations: 5 },
    tools: [
      tool({
        name: 'fixture_read',
        readOnly: true,
        execute: () => ({ success: true, output: 'evidence '.repeat(280) }),
      }),
    ],
  });
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `Prior ${index} ` + 'history '.repeat(100),
  }));
  const result = await s.runtime.run({ ...s.request, history });
  assert.equal(result.success, true);
  assert.equal(result.budget.modelRequests, 3);
  assert.equal(result.budget.toolCalls, 2);
  assert.ok(result.budget.generations >= 3);
  assert.ok(requests[0].messages[0].content.includes('Loom context handoff'));
  const handoffs = s.runtime.events('one').filter((event) => event.type === 'handoff');
  assert.ok(handoffs.length >= 2);
  const db = s.connection().db;
  for (const event of handoffs) {
    const row = db.query('SELECT snapshot_json FROM loom_checkpoints WHERE id=?', [
      event.data.checkpointId,
    ])[0];
    assert.equal(JSON.parse(row.snapshot_json).kind, 'handoff');
  }
  assert.equal(db.query('SELECT count(*) AS n FROM loom_models')[0].n, 3);
  assert.equal(db.query('SELECT count(*) AS n FROM loom_tools')[0].n, 2);
});
test('a context-generation limit produces a failed receipt instead of resetting the budget', async (t) => {
  const s = setup(t, {
    provider: new Provider(() => reply('unreachable')),
    limits: { contextBytes: 2048, maxGenerations: 1 },
  });
  const result = await s.runtime.run({
    ...s.request,
    history: [{ role: 'user', content: 'x'.repeat(6000) }],
  });
  assert.equal(result.success, false);
  assert.equal(result.budget.modelRequests, 0);
  assert.match(result.error, /generation budget/);
});
test('on-demand discovery returns an actual registered schema and the following call uses it', async (t) => {
  const provider = new Provider((request, count) => {
    if (count === 1) return toolReply('loom_discover', { query: 'fixture_read' });
    if (count === 2) {
      assert.ok(request.tools.some((item) => item.name === 'fixture_read'));
      const response = request.messages.find((item) => item.role === 'tool');
      assert.ok(
        JSON.parse(response.result.output).tools.some((item) => item.name === 'fixture_read'),
      );
      return toolReply('fixture_read', { text: 'read' });
    }
    return reply('Read');
  });
  let reads = 0;
  const s = setup(t, {
    provider,
    tools: [
      tool({
        name: 'fixture_read',
        readOnly: true,
        execute: () => {
          reads++;
          return { success: true, output: 'observed bytes' };
        },
      }),
    ],
  });
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, true);
  assert.equal(reads, 1);
  assert.equal(result.budget.toolCalls, 2);
});
test('invalid host verification booleans remain errors and cannot become a successful receipt', async (t) => {
  const s = setup(t, {
    verifier: { version: '1', verify: () => ({ success: 'yes', summary: 'invalid' }) },
  });
  await assert.rejects(s.runtime.run(s.request), /verification/);
  assert.equal(s.runtime.status('one').result, null);
  assert.equal(s.runtime.status('one').verification, null);
});
test('read-only inspection needs no provider and preserves database bytes and scope boundaries', async (t) => {
  const s = setup(t);
  await s.runtime.run(s.request);
  await s.runtime.close();
  const hash = () =>
    crypto.createHash('sha256').update(fs.readFileSync(s.options.dbPath)).digest('hex');
  const before = hash();
  const options = { ...s.options, view: 'status', runId: 'one' };
  assert.equal(inspectLoom(options).status.result.success, true);
  assert.equal(inspectLoom({ ...options, agent: 'foreign' }).status, null);
  assert.equal(
    inspectLoom({ ...options, view: 'conversation', conversationId: 'conversation' }).conversation
      .history.length,
    2,
  );
  assert.equal(inspectLoom({ ...options, view: 'history' }).history.length, 1);
  assert.ok(inspectLoom({ ...options, view: 'events', limit: 2 }).events.length === 2);
  assert.equal(hash(), before);
  const missing = path.join(s.directory, 'missing', 'mimir.db');
  assert.throws(() => inspectLoom({ ...options, dbPath: missing }));
  assert.equal(fs.existsSync(path.dirname(missing)), false);
});
test('event budget exhaustion saves an explicit failed outcome with terminal receipt space intact', async (t) => {
  class ManyDeltas extends Provider {
    async stream(request, emit) {
      this.calls++;
      request.onAttempt();
      for (let i = 0; i < 100; i++) await emit('x');
      return reply('x'.repeat(100));
    }
  }
  const s = setup(t, { provider: new ManyDeltas(), limits: { maxEvents: 32 } });
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, false);
  assert.match(result.error, /event budget/);
  const events = s.runtime.events('one');
  assert.equal(events.at(-1).type, 'done');
  assert.ok(events.length <= 32);
  assert.equal((await s.runtime.run(s.request)).cached, true);
});
