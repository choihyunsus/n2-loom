// Faults between model/tool receipts and progress must roll back together, with retry budgets preserved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./store-helpers.cjs');
const { DialogueLease } = require('../dist/lease');
const { RunStore } = require('../dist/run-store');
const { checkedRequest } = require('../dist/input');
const { checkedLimits } = require('../dist/limits');
const { prepareModel, modelAttempt, completeModel, modelRecord } = require('../dist/model-store');
const { prepareTool, completeTool, toolRecord } = require('../dist/tool-store');
const { appendEvent, readEvents } = require('../dist/events');
const { conversation } = require('../dist/conversations');
const { fingerprint } = require('../dist/values');
const { encode } = require('../dist/store');
function setupRun(t, limits = {}) {
  const fixtureData = fixture(t),
    store = fixtureData.open();
  const request = checkedRequest(
    { runId: 'one', conversationId: 'chat', message: 'hello' },
    'fixture',
  );
  const config = { version: '1', limits: checkedLimits(limits) };
  const open = (input = request) => {
    const lease = new DialogueLease(store, input.runId);
    fixtureData.cleanup.push(() => lease.release());
    const run = new RunStore(store, lease, config.limits);
    return { run, lease, begin: () => run.begin(input, config, []) };
  };
  const active = open();
  active.begin();
  return { ...fixtureData, ...active, open, store, request, config };
}
function reply(extra = {}) {
  return {
    text: 'hello',
    calls: [],
    stop: 'complete',
    model: 'fixture',
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    ...extra,
  };
}
test('run input, config and conversation revisions fence restart without adopting foreign state', (t) => {
  const s = setupRun(t);
  assert.equal(s.run.get().revision, 1);
  assert.throws(
    () => s.run.begin({ ...s.request, message: 'changed' }, s.config, []),
    /changed input/,
  );
  assert.throws(() => s.run.begin(s.request, { ...s.config, version: '2' }, []), /changed input/);
  s.run.interrupt('fixture');
  s.lease.release();
  const resumed = s.open();
  assert.equal(resumed.begin().state, 'running');
  resumed.lease.release();
  const later = s.open({ ...s.request, runId: 'two' });
  assert.equal(later.begin().revision, 2);
  later.lease.release();
  const stale = s.open();
  assert.throws(() => stale.begin(), /conversation advanced/);
  assert.throws(() => stale.run.saveProgress(stale.run.get().progress), /conversation advanced/);
  assert.throws(() => appendEvent(stale.run, 'delta', { text: 'stale' }), /conversation advanced/);
  assert.equal(conversation(s.store, 'chat').revision, 2);
});
test('failed run initialization rolls back the conversation reservation', (t) => {
  const s = setupRun(t);
  s.lease.release();
  s.store.db.execute(
    "CREATE TRIGGER fixture_fail BEFORE INSERT ON loom_runs BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  const next = s.open({ ...s.request, runId: 'two' });
  assert.throws(() => next.begin(), /fixture failure/);
  assert.equal(conversation(s.store, 'chat').revision, 1);
});
test('model attempts reserve cumulative tokens before invocation and preserve limits after restart', (t) => {
  const s = setupRun(t, { maxModelRequests: 2, maxOutputTokens: 16, maxTotalOutputTokens: 32 });
  const hash = fingerprint({ request: 1 });
  prepareModel(s.run, 0, hash);
  modelAttempt(s.run, 0);
  s.run.interrupt('fixture');
  s.lease.release();
  const next = s.open();
  next.begin();
  prepareModel(next.run, 0, hash);
  modelAttempt(next.run, 0);
  assert.throws(() => modelAttempt(next.run, 0), /budget exhausted/);
  assert.throws(() => prepareModel(next.run, 0, fingerprint({ request: 2 })), /changed input/);
  const state = next.run.get();
  assert.equal(state.modelRequests, 2);
  assert.equal(state.outputReserved, 32);
  assert.equal(modelRecord(next.run, 0).attempts, 2);
});
test('model reply and dialogue progress commit atomically across a database fault', (t) => {
  const s = setupRun(t);
  prepareModel(s.run, 0, fingerprint({ request: 1 }));
  modelAttempt(s.run, 0);
  const output = reply(),
    progress = {
      ...s.run.get().progress,
      phase: 'finished',
      output: output.text,
      success: true,
      lastReply: output,
    };
  s.store.db.execute(
    "CREATE TRIGGER fixture_fail BEFORE UPDATE OF progress_json ON loom_runs BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  assert.throws(() => completeModel(s.run, 0, output, progress), /fixture failure/);
  assert.equal(modelRecord(s.run, 0).state, 'pending');
  assert.equal(s.run.get().progress.phase, 'model');
  s.store.db.execute('DROP TRIGGER fixture_fail');
  completeModel(s.run, 0, output, progress);
  assert.equal(modelRecord(s.run, 0).result.text, 'hello');
  assert.equal(s.run.get().progress.phase, 'finished');
});
test('tool identity, result event and progress stay stable across retry and commit failure', (t) => {
  const s = setupRun(t);
  const output = reply({
    stop: 'tools',
    calls: [{ id: 'call', name: 'write', arguments: { text: 'hi' } }],
  });
  const progress = s.run.get().progress;
  progress.phase = 'tools';
  progress.lastReply = output;
  progress.messages.push({ role: 'assistant', reply: output });
  s.run.saveProgress(progress);
  const input = { name: 'write', arguments: { text: 'hi' } };
  const tool = prepareTool(s.run, 0, 0, input);
  assert.equal(prepareTool(s.run, 0, 0, input).requestId, tool.requestId);
  assert.equal(s.run.get().toolCalls, 1);
  assert.throws(() => prepareTool(s.run, 0, 0, { ...input, arguments: {} }), /changed arguments/);
  const result = { success: true, output: 'a'.repeat(999) + '😀', modifiedFiles: ['file.txt'] };
  progress.messages.push({ role: 'tool', callId: 'call', name: 'write', result });
  progress.nextTool = 1;
  progress.modifiedFiles = ['file.txt'];
  progress.toolRequestIds = [tool.requestId];
  s.store.db.execute(
    "CREATE TRIGGER fixture_fail BEFORE INSERT ON loom_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  assert.throws(() => completeTool(s.run, 0, 0, result, progress), /fixture failure/);
  assert.equal(toolRecord(s.run, 0, 0).state, 'pending');
  assert.equal(s.run.get().progress.nextTool, 0);
  s.store.db.execute('DROP TRIGGER fixture_fail');
  const event = completeTool(s.run, 0, 0, result, progress);
  assert.equal(event.data.output, 'a'.repeat(999));
  assert.equal(event.sequence, 1);
  assert.equal(toolRecord(s.run, 0, 0).state, 'completed');
  assert.equal(s.run.get().progress.nextTool, 1);
});
test('event replay pages use committed cursors and reserve room for terminal state', (t) => {
  const s = setupRun(t, { maxEvents: 32 });
  for (let index = 0; index < 28; index++) appendEvent(s.run, 'delta', { text: 'one' });
  assert.throws(() => appendEvent(s.run, 'delta', { text: 'overflow' }), /budget exhausted/);
  appendEvent(s.run, 'error', { reason: 'limit' }, true);
  assert.deepEqual(
    readEvents(s.store, 'one', 26, 3).map((event) => event.sequence),
    [27, 28, 29],
  );
  assert.deepEqual(readEvents(s.store, 'one', 29), []);
  assert.throws(() => readEvents(s.store, 'one', -1));
  assert.throws(() => readEvents(s.store, 'one', 0, 1000));
  assert.equal(s.run.get().eventSequence, 29);
});
test('hashed but invalid progress and numeric counters fail before another model or tool action', (t) => {
  const s = setupRun(t),
    original = s.run.get().progress;
  const invalid = encode({ ...original, nextTool: -1 }, 2097152);
  s.store.db.execute('UPDATE loom_runs SET progress_json=?,progress_hash=?', [
    invalid.json,
    invalid.hash,
  ]);
  assert.throws(() => s.run.get(), /tool index/);
  const valid = encode(original, 2097152);
  s.store.db.execute('UPDATE loom_runs SET progress_json=?,progress_hash=?,model_requests=1000', [
    valid.json,
    valid.hash,
  ]);
  assert.throws(() => prepareModel(s.run, 0, fingerprint({ request: 1 })), /model requests/);
  assert.equal(s.store.db.query('SELECT count(*) AS count FROM loom_models')[0].count, 0);
});
