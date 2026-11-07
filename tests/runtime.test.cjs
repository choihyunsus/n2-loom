// Public entry points must connect true incremental delivery, N2R checks, Hecaton effects and shared memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Provider, reply, setup, tool, toolReply } = require('./runtime-helpers.cjs');
test('class-bound provider streams before completion and saves the full required lifecycle exactly once', async (t) => {
  let finished = false,
    delivered = false;
  class Streaming extends Provider {
    async stream(request, emit) {
      this.calls++;
      request.onAttempt?.();
      await emit('안녕');
      assert.equal(delivered, true);
      await emit('😀');
      finished = true;
      return reply('안녕😀');
    }
  }
  const s = setup(t, { provider: new Streaming() }),
    events = [];
  const result = await s.runtime.run(s.request, {
    onEvent(event) {
      events.push(event);
      if (event.type === 'delta') {
        assert.equal(finished, false);
        delivered = true;
      }
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.output, '안녕😀');
  assert.equal(result.verification.kind, 'protocol');
  assert.deepEqual(
    result.lifecycle.phases.map((phase) => phase.phase),
    ['boot', 'work_start', 'work_end', 'end'],
  );
  assert.equal(result.budget.modelRequests, 1);
  assert.equal(result.cached, false);
  assert.ok(result.checkpointId);
  assert.equal(events.at(-1).type, 'done');
  assert.ok(events.every((event) => event.replay === false));
  assert.equal(s.runtime.conversation('conversation').history.length, 2);
  const db = s.connection();
  assert.equal(
    db.db.query("SELECT count(*) AS n FROM experiences WHERE category='loom-dialogue'")[0].n,
    1,
  );
  const replay = [];
  const cached = await s.runtime.run(s.request, {
    afterSequence: events.at(-2).sequence,
    onEvent: (event) => replay.push(event),
  });
  assert.equal(cached.cached, true);
  assert.equal(cached.experienceId, result.experienceId);
  assert.equal(s.provider.calls, 1);
  assert.equal(replay.length, 1);
  assert.equal(replay[0].replay, true);
  assert.equal(replay[0].type, 'done');
});
test('actual file tool execution, immutable confirmation and native host verification work together', async (t) => {
  let filename,
    writes = 0,
    confirmations = 0,
    verifications = 0;
  const provider = new Provider((request) =>
    request.messages.some((item) => item.role === 'tool') ? reply('Saved') : toolReply(),
  );
  class Confirmation {
    version = '1';
    async request(context) {
      confirmations++;
      assert.equal(context.arguments.text, 'hello');
      assert.ok(Object.isFrozen(context.arguments));
      assert.ok(Object.isFrozen(context.tool.inputSchema));
      return true;
    }
  }
  class Verifier {
    version = '1';
    async verify(context) {
      verifications++;
      assert.deepEqual(context.modifiedFiles, [filename]);
      return {
        success: fs.readFileSync(filename, 'utf8') === 'hello',
        summary: 'Read actual file bytes',
        evidence: { bytes: 5 },
      };
    }
  }
  const s = setup(t, {
    provider,
    tools: [
      tool({
        execute(args) {
          writes++;
          fs.writeFileSync(filename, args.text);
          return { success: true, output: 'written', modifiedFiles: [filename] };
        },
      }),
    ],
    confirmation: new Confirmation(),
    verifier: new Verifier(),
  });
  filename = path.join(s.directory, 'output.txt');
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, true);
  assert.equal(result.verification.kind, 'host');
  assert.equal(result.budget.toolCalls, 1);
  assert.equal(writes, 1);
  assert.equal(confirmations, 1);
  assert.equal(verifications, 1);
  assert.equal(provider.calls, 2);
  assert.deepEqual(result.modifiedFiles, [filename]);
  assert.equal(s.runtime.status('one').progress.toolRequestIds.length, 1);
  await s.runtime.close();
  const next = s.reopen();
  assert.equal((await next.run(s.request)).cached, true);
  assert.equal(writes, 1);
  assert.equal(provider.calls, 2);
  assert.equal(verifications, 1);
});
test('declined confirmation blocks the effect and protocol verification exposes the failed tool', async (t) => {
  let effects = 0;
  const s = setup(t, {
    provider: new Provider((request) =>
      request.messages.some((item) => item.role === 'tool') ? reply('Declined') : toolReply(),
    ),
    tools: [
      tool({
        execute() {
          effects++;
          return { success: true, output: 'effect' };
        },
      }),
    ],
    confirmation: { version: '1', request: () => false },
  });
  const result = await s.runtime.run(s.request);
  assert.equal(effects, 0);
  assert.equal(result.success, false);
  assert.equal(result.verification.success, false);
  assert.equal(result.budget.failures, 1);
  assert.equal(result.budget.toolCalls, 1);
});
test('chat mode exposes no tools and rejects tool-call completion without executing it', async (t) => {
  let effects = 0;
  const s = setup(t, {
    provider: new Provider((request) => {
      assert.deepEqual(request.tools, []);
      return toolReply();
    }),
    tools: [
      tool({
        execute() {
          effects++;
          return { success: true, output: 'effect' };
        },
      }),
    ],
  });
  const result = await s.runtime.run({ ...s.request, mode: 'chat' });
  assert.equal(result.success, false);
  assert.equal(effects, 0);
  assert.equal(result.budget.toolCalls, 0);
});
test('preparation failure prevents provider access and preserves the previous meaningful conversation', async (t) => {
  let ready = true;
  const s = setup(t, {
    preparation: {
      version: '1',
      prepare() {
        return { success: ready, output: ready ? 'ready' : 'unavailable' };
      },
    },
  });
  await s.runtime.run(s.request);
  const previous = s.runtime.conversation('conversation');
  ready = false;
  const failed = await s.runtime.run({ ...s.request, runId: 'two', message: 'Next task' });
  assert.equal(failed.success, false);
  assert.equal(failed.verification, null);
  assert.equal(s.provider.calls, 1);
  const current = s.runtime.conversation('conversation');
  assert.deepEqual(current.history, previous.history);
  assert.equal(current.checkpointId, previous.checkpointId);
  assert.equal(current.revision, 2);
  assert.equal((await s.runtime.run(s.request)).cached, true);
});
test('lost final result commit retries saved N2R work without repeating provider, tools or verifier', async (t) => {
  let verifications = 0;
  const s = setup(t, {
      verifier: {
        version: '1',
        verify() {
          verifications++;
          return { success: true, summary: 'fixture checked' };
        },
      },
    }),
    db = s.connection();
  db.db.execute(
    "CREATE TRIGGER fixture_fail BEFORE UPDATE OF result_json ON loom_runs WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fixture final failure'); END",
  );
  await assert.rejects(s.runtime.run(s.request), /fixture final failure/);
  assert.equal(s.runtime.status('one').state, 'interrupted');
  assert.equal(s.provider.calls, 1);
  assert.equal(verifications, 1);
  assert.equal(
    db.db.query("SELECT count(*) AS n FROM experiences WHERE category='loom-dialogue'")[0].n,
    0,
  );
  assert.deepEqual(s.runtime.conversation('conversation').history, []);
  assert.ok(s.runtime.events('one').every((event) => event.type !== 'done'));
  db.db.execute('DROP TRIGGER fixture_fail');
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, true);
  assert.equal(s.provider.calls, 1);
  assert.equal(verifications, 1);
  assert.equal(
    db.db.query("SELECT count(*) AS n FROM experiences WHERE category='loom-dialogue'")[0].n,
    1,
  );
});
test('model failure redacts host errors and a cancelled stream resumes with cumulative attempts', async (t) => {
  const controller = new AbortController();
  const s = setup(t);
  await assert.rejects(
    s.runtime.run(s.request, {
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'delta') controller.abort();
      },
    }),
  );
  assert.equal(s.runtime.status('one').state, 'interrupted');
  assert.equal(s.runtime.status('one').modelRequests, 1);
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, true);
  assert.equal(result.budget.modelRequests, 2);
  const failing = setup(t, {
    provider: new Provider(() => {
      throw new Error('fixture-secret-credential');
    }),
  });
  await assert.rejects(
    failing.runtime.run(failing.request),
    (error) =>
      !error.message.includes('fixture-secret') && /Model request failed/.test(error.message),
  );
  assert.ok(!JSON.stringify(failing.runtime.status('one')).includes('fixture-secret'));
});
test('unknown non-idempotent effects require explicit Hecaton reconciliation before continuation', async (t) => {
  let effects = 0;
  const s = setup(t, {
    provider: new Provider((request) =>
      request.messages.some((item) => item.role === 'tool') ? reply('Recovered') : toolReply(),
    ),
    tools: [
      tool({
        execute() {
          effects++;
          throw new Error('connection lost after effect');
        },
      }),
    ],
  });
  await assert.rejects(s.runtime.run(s.request));
  const requestId = s.runtime.events('one').find((event) => event.type === 'tool_call')
    .data.requestId;
  assert.equal(s.runtime.toolStatus(requestId).needsReconciliation, true);
  await assert.rejects(s.runtime.run(s.request), /reconcil/i);
  assert.equal(effects, 1);
  assert.equal(s.provider.calls, 1);
  s.runtime.reconcileTool(
    requestId,
    { success: true, output: 'Observed committed effect' },
    'Verified actual output independently',
  );
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, true);
  assert.equal(effects, 1);
  assert.equal(s.provider.calls, 2);
});
