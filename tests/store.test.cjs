// Verify additive schema initialization, canonical paths and cross-process fencing before runtime mutations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./store-helpers.cjs');
const { LoomStore, encode, decode, column } = require('../dist/store');
const { DialogueLease } = require('../dist/lease');
test('Loom creates seven scoped tables with one stable storage identity while retaining common memory', (t) => {
  const setup = fixture(t),
    first = setup.open();
  const source = first.memory.insertExperience({
    project: 'foreign',
    agent: 'other',
    type: 'pattern',
    category: 'fixture',
    severity: 'info',
    context: 'keep',
    action: 'preserve',
    outcome: 'untouched',
  });
  const row = first.db.query('SELECT * FROM experiences WHERE id=?', [source.id])[0];
  const columns = first.db.query('SELECT name FROM pragma_table_info(?)', ['experiences']);
  const second = setup.open({ project: 'second', agent: 'second' });
  assert.equal(first.storageId, second.storageId);
  assert.equal(
    second.db.query(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name GLOB 'loom_*'",
    )[0].count,
    7,
  );
  assert.deepEqual(second.db.query('SELECT * FROM experiences WHERE id=?', [source.id])[0], row);
  assert.deepEqual(
    second.db.query('SELECT name FROM pragma_table_info(?)', ['experiences']),
    columns,
  );
  assert.equal(second.db.query('PRAGMA integrity_check')[0].integrity_check, 'ok');
});
test('future, unversioned, partial and malformed module schemas fail explicitly without adopting old state', (t) => {
  for (const sql of [
    "UPDATE meta SET value='2' WHERE key='loom_schema_version'",
    "DELETE FROM meta WHERE key='loom_schema_version'",
    'DROP TABLE loom_events',
    'ALTER TABLE loom_events ADD COLUMN unexpected TEXT',
    [
      'ALTER TABLE loom_events RENAME TO fixture_events',
      'CREATE TABLE loom_events AS SELECT * FROM fixture_events',
    ],
  ]) {
    const setup = fixture(t),
      store = setup.open();
    for (const statement of Array.isArray(sql) ? sql : [sql]) store.db.execute(statement);
    assert.throws(() => new LoomStore(setup.options), /schema|migration/);
  }
});
test('stored JSON hashes, UTF-8 boundaries and row projections reject corruption before use', () => {
  const data = JSON.parse('{"text":"한글😀","__proto__":{"literal":true}}');
  const encoded = encode(data, 1024);
  assert.equal(
    encoded.hash,
    encode({ __proto__: null, text: '한글😀', ['__proto__']: { literal: true } }, 1024).hash,
  );
  assert.deepEqual(decode(encoded.json, encoded.hash, 1024), data);
  assert.equal({}.literal, undefined);
  assert.throws(() => decode(encoded.json + ' ', encoded.hash, 1024), /hash mismatch/);
  assert.throws(() => decode(encoded.json, encoded.hash, 1));
  assert.throws(() => encode({ value: '\ud800' }, 1024));
  assert.throws(() => column('name;DROP', 10));
  assert.throws(() => column('name', Infinity));
  assert.throws(() => encode(new Array(1000000), 1024), /element limit/);
});
test('one scope owns one dialogue and other scopes remain independent', (t) => {
  const setup = fixture(t),
    first = setup.open(),
    second = setup.open(),
    foreign = setup.open({ agent: 'another' });
  const one = new DialogueLease(first, 'one'),
    other = new DialogueLease(foreign, 'other');
  setup.cleanup.push(
    () => one.release(),
    () => other.release(),
  );
  assert.throws(() => new DialogueLease(second, 'two'), /active Loom/);
  assert.equal(
    one.mutate(() => 42),
    42,
  );
  one.release();
  const next = new DialogueLease(second, 'two');
  setup.cleanup.push(() => next.release());
  assert.doesNotThrow(() => next.assert());
});
test('expired ownership rejects late writes and an old release preserves the replacement nonce', (t) => {
  const setup = fixture(t),
    first = setup.open(),
    second = setup.open();
  const one = new DialogueLease(first, 'one');
  setup.cleanup.push(() => one.release());
  first.db.execute('UPDATE loom_leases SET expires_at=0');
  const two = new DialogueLease(second, 'two');
  setup.cleanup.push(() => two.release());
  assert.throws(
    () =>
      one.mutate(() => {
        throw new Error('must never reach mutation');
      }),
    /ownership/,
  );
  one.release();
  assert.equal(second.db.query('SELECT nonce FROM loom_leases')[0].nonce, two.nonce);
});
test('durable paths reject memory, directories and malformed identity before a usable store is returned', (t) => {
  const setup = fixture(t);
  for (const dbPath of [':memory:', setup.directory, '\ud800'])
    assert.throws(() => new LoomStore({ ...setup.options, dbPath }));
  assert.throws(() => new LoomStore({ ...setup.options, agent: '' }));
});
