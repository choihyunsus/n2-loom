// Bound literal requests and cumulative limits before a dialogue acquires ownership or invokes a model.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkedRequest, checkedHistory } = require('../dist/input');
const { checkedLimits } = require('../dist/limits');
const base = { runId: 'run', conversationId: 'conversation', message: 'Hello' };
test('request defaults preserve explicit undefined optional fields and reject null or unknown values', () => {
  const expected = checkedRequest(base, 'provider');
  assert.deepEqual(
    checkedRequest(
      { ...base, system: undefined, mode: undefined, history: undefined, providerId: undefined },
      'provider',
    ),
    expected,
  );
  for (const key of ['system', 'mode', 'history', 'providerId'])
    assert.throws(() => checkedRequest({ ...base, [key]: null }, 'provider'));
  assert.throws(() => checkedRequest({ ...base, extra: undefined }, 'provider'));
  assert.throws(() => checkedRequest({ ...base, message: ' ' }, 'provider'));
  assert.throws(() => checkedRequest({ ...base, message: '\ud800' }, 'provider'));
  assert.equal(
    checkedRequest({ ...base, message: '한'.repeat(21845) }, 'provider').message.length,
    21845,
  );
  assert.throws(() => checkedRequest({ ...base, message: '한'.repeat(21846) }, 'provider'));
});
test('history remains literal bounded user/assistant data and cannot smuggle tool roles or sparse entries', () => {
  assert.equal(
    checkedHistory(Array.from({ length: 200 }, () => ({ role: 'user', content: 'x' }))).length,
    200,
  );
  assert.throws(() =>
    checkedHistory(Array.from({ length: 201 }, () => ({ role: 'user', content: 'x' }))),
  );
  for (const value of [
    [,],
    [{ role: ['user'], content: 'x' }],
    [{ role: 'tool', content: 'x' }],
    [{ role: 'user', content: 'x', input: 'extra' }],
  ])
    assert.throws(() => checkedHistory(value));
  assert.throws(() =>
    checkedHistory(
      Array.from({ length: 20 }, () => ({ role: 'user', content: 'x'.repeat(65536) })),
    ),
  );
});
test('limits retain whole-run budgets and reserve space for durable recovery', () => {
  const limits = checkedLimits();
  assert.equal(limits.maxTurns, 50);
  assert.equal(limits.maxFailures, 5);
  assert.equal(Object.isFrozen(limits), true);
  for (const value of [
    null,
    { unknown: 1 },
    { maxTurns: 0 },
    { contextBytes: 100 },
    { maxOutputTokens: 1024, maxTotalOutputTokens: 512 },
    { maxModelRequests: Infinity },
    { maxEvents: 1 },
  ])
    assert.throws(() => checkedLimits(value));
});
