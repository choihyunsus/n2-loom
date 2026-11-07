// Strict per-command flags keep read-only inspection independent of providers and executable host code.
import { parseArgs } from 'node:util';
import { hostOptions, readJsonFile } from './cli-files';
import { openAIResponses } from './provider-openai';
import { anthropicMessages } from './provider-anthropic';
import { geminiInteractions } from './provider-gemini';
import { openAICompatible } from './provider-chat';
import { ollamaChat } from './provider-ollama';
import { objectValue } from './model-validation';
import type { LoomOptions, LoomRequest } from './run-types';
export type Flags = Record<string, string | boolean | undefined>;
const SCOPE = ['db', 'project', 'agent'];
const HOST = ['host', 'provider', 'model', 'endpoint', 'limits'];
const COMMANDS: Record<string, string[]> = {
  run: [...SCOPE, ...HOST, 'request', 'run-id', 'conversation-id', 'message', 'mode', 'stream'],
  status: [...SCOPE, 'run-id'],
  events: [...SCOPE, 'run-id', 'after', 'limit'],
  conversation: [...SCOPE, 'conversation-id'],
  history: [...SCOPE, 'limit', 'offset'],
  tools: [...SCOPE, ...HOST],
  'tool-status': [...SCOPE, 'request-id'],
  reconcile: [...SCOPE, ...HOST, 'request-id', 'result', 'evidence'],
  mcp: [...SCOPE, ...HOST],
};
export function parseCli(args: string[]): { command: string; values: Flags } {
  if (!args.length || ['help', '--help', '-h'].includes(args[0]!))
    return { command: 'help', values: {} };
  const command = args[0]!,
    names = COMMANDS[command];
  if (!names) throw new Error('Unknown command; use n2-loom help');
  const options = Object.fromEntries(
    names.map((name) => [
      name,
      { type: name === 'stream' ? ('boolean' as const) : ('string' as const) },
    ]),
  );
  const parsed = parseArgs({
    args: args.slice(1),
    options,
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Duplicate --${token.name}`);
    seen.add(token.name);
  }
  return { command, values: parsed.values };
}
export function required(values: Flags, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value;
}
export function scopeOptions(values: Flags) {
  return {
    dbPath: required(values, 'db'),
    project: required(values, 'project'),
    agent: required(values, 'agent'),
  };
}
export async function engineOptions(values: Flags): Promise<LoomOptions> {
  const host = values.host ? await hostOptions(required(values, 'host')) : {};
  if (host.provider && ['provider', 'model', 'endpoint'].some((key) => values[key] !== undefined))
    throw new Error('Choose a host provider or CLI provider settings');
  return {
    ...host,
    ...scopeOptions(values),
    provider: host.provider ?? cliProvider(values),
    limits:
      values.limits === undefined
        ? host.limits
        : objectValue(readJsonFile(required(values, 'limits'), 4096)),
  };
}
function cliProvider(values: Flags) {
  const provider = required(values, 'provider');
  const options = {
    id: provider,
    model: required(values, 'model'),
    endpoint: values.endpoint === undefined ? undefined : required(values, 'endpoint'),
  };
  if (provider === 'openai')
    return openAIResponses({ ...options, apiKey: process.env.OPENAI_API_KEY });
  if (provider === 'anthropic')
    return anthropicMessages({ ...options, apiKey: process.env.ANTHROPIC_API_KEY });
  if (provider === 'gemini')
    return geminiInteractions({ ...options, apiKey: process.env.GEMINI_API_KEY });
  if (provider === 'ollama') return ollamaChat(options);
  if (provider === 'compatible')
    return openAICompatible({
      ...options,
      endpoint: required(values, 'endpoint'),
      apiKey: process.env.OPENAI_API_KEY,
    });
  throw new Error('Provider must be openai, anthropic, gemini, ollama or compatible');
}
export function runRequest(values: Flags): LoomRequest {
  if (values.request !== undefined) {
    if (['run-id', 'conversation-id', 'message', 'mode'].some((key) => values[key] !== undefined))
      throw new Error('Use a request file or individual request flags');
    return readJsonFile(required(values, 'request')) as unknown as LoomRequest;
  }
  return {
    runId: required(values, 'run-id'),
    conversationId: required(values, 'conversation-id'),
    message: required(values, 'message'),
    ...(values.mode === undefined ? {} : { mode: required(values, 'mode') as 'chat' | 'agent' }),
  };
}
export function numberOption(values: Flags, name: string, fallback: number): number {
  if (values[name] === undefined) return fallback;
  const text = required(values, name);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new Error(`Invalid --${name}`);
  return Number(text);
}
export const HELP = `n2-loom 1.0.0 — scoped streaming dialogue

Every operation requires --db <file> --project <name> --agent <name>.

run           --request <json-file> or --run-id <id> --conversation-id <id> --message <text> [--mode chat|agent] [--stream]
status        --run-id <id>
events        --run-id <id> [--after <sequence>] [--limit <1..100>]
conversation  --conversation-id <id>
history       [--limit <1..100>] [--offset <n>]
tools         Inspect configured tool definitions
tool-status   --request-id <Hecaton-request-id>
reconcile     --request-id <id> --result <json-file> --evidence <text>
mcp           Serve the scoped MCP interface over stdio

run/tools/reconcile/mcp use --host <trusted-local-js> or --provider <openai|anthropic|gemini|ollama|compatible> --model <name>.
Optional --endpoint is a complete API endpoint. Optional --limits <json-file> configures budgets.
Credentials use OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY.
--stream emits newline-delimited event objects, followed by a result object.
Read-only commands open existing storage without loading host code.
`;
