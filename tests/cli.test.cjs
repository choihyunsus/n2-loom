// Verify normal command entry points, read-only access and bounded data files without model credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cliSetup } = require('./cli-helpers.cjs');
const { parseCli } = require('../dist/cli-options');
const { readJsonFile } = require('../dist/cli-files');
test('CLI runs a streamed dialogue, replays its cache and inspects it without loading host code', async (t) => {
  const s = cliSetup(t),
    args = ['--host', s.host, '--run-id', 'one', '--conversation-id', 'chat', '--message', 'hello'];
  const first = await s.run('run', [...args, '--stream']);
  assert.equal(first.code, 0, first.stderr);
  const lines = first.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].event.type, 'started');
  assert.equal(lines.at(-1).result.output, 'Hello😀');
  assert.equal(lines.at(-1).result.success, true);
  const again = await s.run('run', args);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).cached, true);
  fs.writeFileSync(s.host, 'throw new Error("host-must-stay-unloaded")');
  for (const [command, flags] of [
    ['status', ['--run-id', 'one']],
    ['events', ['--run-id', 'one']],
    ['conversation', ['--conversation-id', 'chat']],
    ['history', []],
  ]) {
    const result = await s.run(command, flags);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout));
  }
});
test('CLI request files accept a UTF-8 BOM and command flags reject ambiguity before execution', async (t) => {
  const s = cliSetup(t),
    request = path.join(s.directory, 'request.json');
  fs.writeFileSync(
    request,
    '\ufeff' + JSON.stringify({ runId: 'one', conversationId: 'chat', message: 'hello' }),
  );
  const result = await s.run('run', ['--host', s.host, '--request', request]);
  assert.equal(result.code, 0, result.stderr);
  assert.throws(() => parseCli(['status', '--db', 'one', '--db', 'two']), /Duplicate/);
  assert.throws(() => parseCli(['status', '--host', 'unused']), /Unknown option/);
  const mixed = await s.run('run', [
    '--host',
    s.host,
    '--request',
    request,
    '--message',
    'ambiguous',
  ]);
  assert.equal(mixed.code, 1);
  assert.match(mixed.stderr, /request file or individual/);
});
test('bounded JSON readers reject malformed UTF-8, directories and oversized files', (t) => {
  const s = cliSetup(t),
    file = path.join(s.directory, 'input.json');
  fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
  assert.throws(() => readJsonFile(file));
  fs.writeFileSync(file, ' '.repeat(1025));
  assert.throws(() => readJsonFile(file, 1024));
  assert.throws(() => readJsonFile(s.directory));
  fs.writeFileSync(file, '{"field":"\\ud800"}');
  assert.throws(() => readJsonFile(file));
});
test('CLI returns a failure exit code for an explicitly incomplete model outcome', async (t) => {
  const s = cliSetup(
    t,
    `module.exports={provider:{id:'fixture',version:'1',model:'fixture',local:true,async generate(){return {text:'Partial',calls:[],stop:'incomplete',model:'fixture',usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null}}}}};`,
  );
  const result = await s.run('run', [
    '--host',
    s.host,
    '--run-id',
    'one',
    '--conversation-id',
    'chat',
    '--message',
    'hello',
  ]);
  assert.equal(result.code, 1);
  const value = JSON.parse(result.stdout);
  assert.equal(value.success, false);
  assert.match(value.error, /incomplete/);
});
