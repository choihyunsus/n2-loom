// CI asserts the selected backend explicitly so native coverage cannot silently use the fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./store-helpers.cjs');
test('the configured Mimir backend is active and preserves SQLite integrity', (t) => {
  const store = fixture(t).open();
  const actual = store.memory.getMode();
  assert.ok(['rust', 'fallback'].includes(actual));
  if (process.env.N2_EXPECT_BACKEND) assert.equal(actual, process.env.N2_EXPECT_BACKEND);
  assert.equal(store.db.query('PRAGMA integrity_check')[0].integrity_check, 'ok');
  assert.deepEqual(store.db.query('PRAGMA foreign_key_check'), []);
});
