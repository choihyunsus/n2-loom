// Deterministic provider fixtures exercise the public runtime through the published dependency contracts.
const { Loom } = require('../dist/library');
const { fixture } = require('./store-helpers.cjs');
function reply(text = 'Done', extra = {}) {
  return {
    text,
    calls: [],
    stop: 'complete',
    model: 'fixture',
    usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
    ...extra,
  };
}
class Provider {
  id = 'fixture';
  version = '1';
  model = 'fixture';
  local = true;
  textStreaming = true;
  calls = 0;
  constructor(generate) {
    this.handler = generate ?? (() => reply());
  }
  async generate(request) {
    return this.stream(request, () => {});
  }
  async stream(request, onText) {
    this.calls++;
    request.onAttempt?.();
    const value = await this.handler(request, this.calls);
    if (value.text) await onText(value.text);
    return value;
  }
}
function setup(t, overrides = {}) {
  const data = fixture(t),
    provider = overrides.provider ?? new Provider();
  const options = { ...data.options, provider, ...overrides };
  const open = (extra = {}) => {
    const runtime = new Loom({ ...options, ...extra });
    data.cleanup.push(() => runtime.close());
    return runtime;
  };
  const runtime = open();
  return {
    ...data,
    provider,
    runtime,
    reopen: open,
    connection: data.open,
    request: { runId: 'one', conversationId: 'conversation', message: 'Perform the task' },
  };
}
function tool(extra = {}) {
  return {
    name: 'fixture_write',
    version: '1',
    description: 'Write the requested fixture',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    execute: () => ({ success: true, output: 'written' }),
    ...extra,
  };
}
function toolReply(name = 'fixture_write', args = { text: 'hello' }) {
  return reply('Working', { stop: 'tools', calls: [{ id: 'call-one', name, arguments: args }] });
}
module.exports = { Provider, reply, setup, tool, toolReply };
