// The real MCP client verifies the stdio entry point, scoped records, cancellation and EOF cleanup.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { cliSetup } = require('./cli-helpers.cjs');
const { chunk } = require('../dist/mcp-output');
const { inspectLoom } = require('../dist/library');
async function connect(t, hostSource) {
  const s = cliSetup(t, hostSource),
    client = new Client({ name: 'loom-fixture', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [s.entry, 'mcp', ...s.scope, '--host', s.host],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (part) => {
    stderr += part.toString();
  });
  s.cleanup.push(async () => {
    await client.close();
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, value: JSON.parse(result.content[0].text) };
  };
  return { ...s, client, transport, call, stderr: () => stderr };
}
test('MCP lists ten tools and completes, replays, inspects and chunks one real scoped dialogue', async (t) => {
  const s = await connect(t);
  const list = await s.client.listTools();
  assert.equal(list.tools.length, 10);
  assert.deepEqual(
    list.tools.map((tool) => tool.name).sort(),
    [
      'loom_cancel',
      'loom_conversation',
      'loom_events',
      'loom_history',
      'loom_read',
      'loom_reconcile',
      'loom_run',
      'loom_status',
      'loom_tool_status',
      'loom_tools',
    ].sort(),
  );
  const input = { runId: 'one', conversationId: 'chat', message: 'hello' };
  const result = await s.call('loom_run', input);
  assert.equal(result.error, false, JSON.stringify(result));
  assert.equal(result.value.output, 'Hello😀');
  assert.equal((await s.call('loom_run', input)).value.cached, true);
  assert.equal((await s.call('loom_status', { runId: 'one' })).value.state, 'completed');
  assert.equal(
    (await s.call('loom_conversation', { conversationId: 'chat' })).value.messageCount,
    2,
  );
  assert.equal((await s.call('loom_history', {})).value.length, 1);
  const events = (await s.call('loom_events', { runId: 'one' })).value.events;
  assert.equal(events.at(-1).type, 'done');
  const page = (await s.call('loom_read', { resource: 'run', id: 'one', limit: 100 })).value;
  assert.equal(page.text.length, 100);
  assert.equal(page.hasMore, true);
  assert.match(page.sha256, /^[a-f0-9]{64}$/);
  const pageTwo = (
    await s.call('loom_read', { resource: 'run', id: 'one', offset: 100, limit: 100 })
  ).value;
  assert.equal(page.sha256, pageTwo.sha256);
  const catalog = (await s.call('loom_tools', {})).value;
  assert.equal(catalog.total, 0);
  assert.deepEqual(catalog.servers, []);
  assert.equal((await s.call('loom_cancel', { runId: 'wrong' })).value.cancelled, false);
  const scoped = await s.client.callTool({
    name: 'loom_run',
    arguments: { ...input, project: 'foreign' },
  });
  assert.equal(scoped.isError, true);
  assert.equal(s.stderr(), '');
});
test('MCP cancellation and transport EOF settle an uncooperative provider and persist interruption', async (t) => {
  const s = await connect(
    t,
    `module.exports={provider:{id:'fixture',version:'1',model:'fixture',local:true,async generate(){return new Promise(()=>{});}}};`,
  );
  const input = { runId: 'one', conversationId: 'chat', message: 'hello' };
  const running = s.call('loom_run', input);
  for (let index = 0; index < 30; index++) {
    const status = await s.call('loom_status', { runId: 'one' });
    if (status.value?.modelRequests) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await s.call('loom_cancel', { runId: 'one' })).value.cancelled, true);
  assert.equal((await running).error, true);
  const resumed = s.call('loom_run', input).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await s.client.close();
  await resumed;
  const status = inspectLoom({ ...s.options, view: 'status', runId: 'one' }).status;
  assert.equal(status.state, 'interrupted');
  assert.equal(status.result, null);
});
test('Unicode JSON chunks are exact past one million characters without splitting surrogate pairs', () => {
  const value = { text: '😀'.repeat(530000) },
    full = JSON.stringify(value);
  const first = chunk(value, 1, 100);
  assert.equal(first.text, Array.from(full).slice(1, 101).join(''));
  const ascii = { text: 'x'.repeat(1100000) },
    tail = chunk(ascii, 1050000, 100);
  assert.equal(tail.text, 'x'.repeat(100));
  assert.equal(tail.hasMore, true);
  assert.throws(() => chunk(value, -1));
  assert.throws(() => chunk(value, 0, 4097));
});
