// Budgets apply to the whole durable run, including resumptions and context handoffs.
import { positiveInteger } from './values';
export interface LoomLimits {
  maxTurns: number;
  maxModelRequests: number;
  maxToolCalls: number;
  maxFailures: number;
  maxGenerations: number;
  maxOutputTokens: number;
  maxTotalOutputTokens: number;
  contextBytes: number;
  modelTimeoutMs: number;
  runTimeoutMs: number;
  observerTimeoutMs: number;
  confirmationTimeoutMs: number;
  maxEvents: number;
  maxEventBytes: number;
  maxTraceBytes: number;
}
const DEFAULTS: LoomLimits = {
  maxTurns: 50,
  maxModelRequests: 64,
  maxToolCalls: 128,
  maxFailures: 5,
  maxGenerations: 10,
  maxOutputTokens: 2048,
  maxTotalOutputTokens: 131072,
  contextBytes: 96000,
  modelTimeoutMs: 120000,
  runTimeoutMs: 3600000,
  observerTimeoutMs: 30000,
  confirmationTimeoutMs: 60000,
  maxEvents: 32768,
  maxEventBytes: 8388608,
  maxTraceBytes: 33554432,
};
const MAXIMUM: LoomLimits = {
  maxTurns: 128,
  maxModelRequests: 256,
  maxToolCalls: 512,
  maxFailures: 32,
  maxGenerations: 32,
  maxOutputTokens: 32768,
  maxTotalOutputTokens: 1048576,
  contextBytes: 1048576,
  modelTimeoutMs: 3600000,
  runTimeoutMs: 3600000,
  observerTimeoutMs: 120000,
  confirmationTimeoutMs: 300000,
  maxEvents: 65536,
  maxEventBytes: 16777216,
  maxTraceBytes: 67108864,
};
export function checkedLimits(value: Partial<LoomLimits> = {}): Readonly<LoomLimits> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid dialogue limits');
  if (Object.keys(value).some((key) => !Object.hasOwn(DEFAULTS, key)))
    throw new Error('Unknown dialogue limit');
  const result = { ...DEFAULTS, ...value };
  for (const key of Object.keys(DEFAULTS) as Array<keyof LoomLimits>)
    positiveInteger(result[key], key, MAXIMUM[key]);
  if (
    result.contextBytes < 2048 ||
    result.maxEventBytes < 262144 ||
    result.maxTraceBytes < 1048576 ||
    result.maxEvents < 32
  )
    throw new Error('Dialogue budgets leave insufficient room for execution and recovery records');
  if (result.maxTotalOutputTokens < result.maxOutputTokens)
    throw new Error('Total output budget is smaller than one request');
  return Object.freeze(result);
}
