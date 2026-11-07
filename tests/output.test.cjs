// A paused stdout consumer must not retain an otherwise completed CLI process indefinitely.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { cliSetup } = require('./cli-helpers.cjs');
const { Loom } = require('../dist/library');
const { Provider, reply } = require('./runtime-helpers.cjs');
test('CLI closes a stalled output pipe after its bounded write deadline', async (t) => {
  const s = cliSetup(t);
  const runtime = new Loom({
    ...s.options,
    provider: new Provider(() => reply('x'.repeat(120000))),
  });
  s.cleanup.push(() => runtime.close());
  const history = Array.from({ length: 16 }, () => ({ role: 'user', content: 'h'.repeat(60000) }));
  const result = await runtime.run({
    runId: 'one',
    conversationId: 'chat',
    message: 'hello',
    history,
  });
  assert.equal(result.success, true);
  await runtime.close();
  const child = spawn(process.execPath, [s.entry, 'status', ...s.scope, '--run-id', 'one'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pause();
  let stderr = '',
    forced = false;
  child.stderr.on('data', (part) => {
    stderr += part.toString();
  });
  const timer = setTimeout(() => {
    forced = true;
    child.kill();
  }, 9000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(forced, false, stderr);
    assert.ok(code === 1 || signal === 'SIGKILL', `Unexpected termination ${code}/${signal}`);
    assert.match(stderr, /Output consumer exceeded its deadline/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    child.stdout.destroy();
  }
});
test('MCP closes and settles bounded async output when its client stops reading replies', async (t) => {
  const s = cliSetup(
    t,
    `module.exports={provider:{id:'fixture',version:'1',model:'fixture',local:true,async generate(){throw new Error('unused');}},tools:Array.from({length:100},(_,i)=>({name:'tool_'+i,version:'1',description:'x'.repeat(160),readOnly:true,inputSchema:{type:'object'},execute:()=>({success:true,output:'read'})}))};`,
  );
  const child = spawn(process.execPath, [s.entry, 'mcp', ...s.scope, '--host', s.host], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '',
    forced = false;
  child.stderr.on('data', (part) => {
    stderr += part.toString();
  });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => {
    forced = true;
    child.kill();
  }, 12000);
  try {
    const handshake = new Promise((resolve, reject) => {
      let input = '';
      const receive = (part) => {
        input += part.toString();
        if (!input.includes('\n')) return;
        child.stdout.removeListener('data', receive);
        child.stdout.pause();
        try {
          resolve(JSON.parse(input.split('\n')[0]));
        } catch (error) {
          reject(error);
        }
      };
      child.stdout.on('data', receive);
      child.once('error', reject);
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'paused-reader', version: '1' },
        },
      }) + '\n',
    );
    assert.ok((await handshake).result.protocolVersion);
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    for (let id = 2; id < 42; id++)
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'loom_tools', arguments: { limit: 100 } },
        }) + '\n',
      );
    const [code, signal] = await once(child, 'exit');
    assert.equal(forced, false, stderr);
    assert.ok(code === 1 || signal === 'SIGKILL');
    assert.match(stderr, /stdio|output timed out|Output consumer/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    child.stdin.destroy();
    child.stdout.destroy();
  }
});
