// Exercise interruption windows and budget boundaries through Loom.run rather than private engine entry points.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Provider, reply, setup, tool, toolReply } = require('./runtime-helpers.cjs');
test('a committed Hecaton effect survives a lost Loom tool commit without executing twice', async (t) => {
  let effects = 0;
  const s = setup(t, {
    provider: new Provider((request) =>
      request.messages.some((item) => item.role === 'tool') ? reply('Recovered') : toolReply(),
    ),
    tools: [
      tool({
        execute() {
          effects++;
          return { success: true, output: 'effect committed' };
        },
      }),
    ],
  });
  const store = s.connection();
  store.db.execute(
    "CREATE TRIGGER fixture_fail BEFORE UPDATE OF result_json ON loom_tools BEGIN SELECT RAISE(ABORT,'fixture tool failure'); END",
  );
  await assert.rejects(s.runtime.run(s.request), /fixture tool failure/);
  assert.equal(effects, 1);
  assert.equal(s.provider.calls, 1);
  const requestId = s.runtime.events('one').find((event) => event.type === 'tool_call')
    .data.requestId;
  assert.equal(s.runtime.toolStatus(requestId).call.state, 'completed');
  assert.equal(s.runtime.status('one').progress.nextTool, 0);
  store.db.execute('DROP TRIGGER fixture_fail');
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, true);
  assert.equal(effects, 1);
  assert.equal(result.budget.toolCalls, 1);
});
test('expired wall-clock budget records a completed effect but prevents the next model invocation', async (t) => {
  let effects = 0;
  const s = setup(t, {
    provider: new Provider(() => toolReply()),
    tools: [
      tool({
        execute() {
          effects++;
          return { success: true, output: 'committed' };
        },
      }),
    ],
  });
  const store = s.connection();
  store.db.execute(
    "CREATE TRIGGER fixture_fail BEFORE UPDATE OF result_json ON loom_tools BEGIN SELECT RAISE(ABORT,'fixture tool failure'); END",
  );
  await assert.rejects(s.runtime.run(s.request));
  store.db.execute('DROP TRIGGER fixture_fail');
  store.db.execute('UPDATE loom_runs SET created_at=0');
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, false);
  assert.equal(effects, 1);
  assert.equal(s.provider.calls, 1);
  assert.equal(result.budget.toolCalls, 1);
  assert.match(s.runtime.status('one').progress.error, /wall-clock/);
});
test('an expired prepared tool call never starts an effect on retry', async (t) => {
  let effects = 0;
  const s = setup(t, {
    provider: new Provider(() => toolReply()),
    tools: [
      tool({
        execute() {
          effects++;
          return { success: true, output: 'effect' };
        },
      }),
    ],
  });
  await assert.rejects(
    s.runtime.run(s.request, {
      onEvent(event) {
        if (event.type === 'tool_call') throw new Error('observer lost');
      },
    }),
  );
  s.connection().db.execute('UPDATE loom_runs SET created_at=0');
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, false);
  assert.equal(effects, 0);
  assert.equal(s.provider.calls, 1);
});
test('unknown effects remain blocked for reconciliation even after the wall-clock deadline', async (t) => {
  const s = setup(t, {
    provider: new Provider(() => toolReply()),
    tools: [
      tool({
        execute() {
          throw new Error('uncertain');
        },
      }),
    ],
  });
  await assert.rejects(s.runtime.run(s.request));
  s.connection().db.execute('UPDATE loom_runs SET created_at=0');
  await assert.rejects(s.runtime.run(s.request), /reconcil/i);
  assert.equal(s.runtime.status('one').state, 'interrupted');
});
test('late approval after the confirmation deadline cannot execute the bound action', async (t) => {
  let approve,
    signal,
    effects = 0;
  const s = setup(t, {
    limits: { confirmationTimeoutMs: 20 },
    confirmation: {
      version: '1',
      request(context) {
        signal = context.signal;
        return new Promise((resolve) => {
          approve = resolve;
        });
      },
    },
    provider: new Provider((request) =>
      request.messages.some((item) => item.role === 'tool')
        ? reply('Approval expired')
        : toolReply(),
    ),
    tools: [
      tool({
        execute() {
          effects++;
          return { success: true, output: 'effect' };
        },
      }),
    ],
  });
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, false);
  assert.equal(signal.aborted, true);
  approve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(effects, 0);
});
test('close settles an uncooperative provider and fences every late streaming callback', async (t) => {
  let emit, callbackSignal, release, notify;
  const entered = new Promise((resolve) => {
    notify = resolve;
  });
  class Hanging extends Provider {
    async stream(request, sink) {
      this.calls++;
      emit = sink;
      callbackSignal = request.signal;
      notify();
      return new Promise((resolve) => {
        release = resolve;
      });
    }
  }
  const s = setup(t, { provider: new Hanging() });
  const running = s.runtime.run(s.request);
  const rejected = assert.rejects(running);
  await entered;
  const first = s.runtime.close();
  assert.equal(s.runtime.close(), first);
  await first;
  await rejected;
  assert.equal(callbackSignal.aborted, true);
  await assert.rejects(emit('late'));
  release(reply());
  await new Promise((resolve) => setImmediate(resolve));
  const next = s.reopen({ provider: new Provider() });
  assert.equal(next.status('one').state, 'interrupted');
  assert.equal(
    next.events('one').some((event) => event.type === 'delta'),
    false,
  );
  const result = await next.run(s.request);
  assert.equal(result.budget.modelRequests, 2);
});
test('model retry attempts and output reservations stop at the configured total', async (t) => {
  class Retrying extends Provider {
    async stream(request) {
      this.calls++;
      request.onAttempt();
      request.onAttempt();
      request.onAttempt();
      return reply('unreachable');
    }
  }
  const s = setup(t, {
    provider: new Retrying(),
    limits: { maxModelRequests: 2, maxOutputTokens: 16, maxTotalOutputTokens: 32 },
  });
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, false);
  assert.equal(result.budget.modelRequests, 2);
  assert.equal(result.budget.outputTokensReserved, 32);
  assert.equal(s.provider.calls, 1);
});
test('identical repeated tool batches stop before a second action', async (t) => {
  let effects = 0;
  const s = setup(t, {
    provider: new Provider(() => toolReply()),
    tools: [
      tool({
        execute() {
          effects++;
          return { success: true, output: 'effect' };
        },
      }),
    ],
  });
  const result = await s.runtime.run(s.request);
  assert.equal(result.success, false);
  assert.equal(effects, 1);
  assert.equal(s.provider.calls, 2);
  assert.match(s.runtime.status('one').progress.error, /Repeated/);
});
test('invalid observer cursors and changed resume configuration do not advance the conversation', async (t) => {
  const s = setup(t);
  assert.throws(() => s.runtime.run(s.request, { afterSequence: 1 }), /cursor/);
  assert.throws(() => s.runtime.run(s.request, { onEvent: 5 }), /callback/);
  assert.equal(s.runtime.conversation('conversation'), undefined);
  await s.runtime.run(s.request);
  await s.runtime.close();
  const changed = s.reopen({ provider: Object.assign(new Provider(), { version: '2' }) });
  await assert.rejects(changed.run(s.request), /changed input or configuration/);
  assert.equal(changed.conversation('conversation').revision, 1);
});
