// Read bounded projections and verify both hashes and record invariants before resuming a run.
import { checkedRequest } from './input';
import { objectValue } from './model-validation';
import { count, progressValue, verificationValue, strings } from './record-values';
import { column, decode, type ReadStore } from './store';
import { identity, textValue } from './values';
import type { RunRecord } from './record-types';
import type { LoomResult } from './run-types';
const MAX_TOOL_CALLS = 512;
const MAX_ERROR_BYTES = 1024;

const BOUNDED = {
  conversation_id: 128,
  request_json: 1179648,
  request_hash: 64,
  config_json: 262144,
  config_hash: 64,
  progress_json: 2097152,
  progress_hash: 64,
  verification_json: 16384,
  verification_hash: 64,
  result_json: 524288,
  result_hash: 64,
  state: 16,
  error: MAX_ERROR_BYTES,
};
const FIELDS = Object.entries(BOUNDED)
  .map(([name, limit]) => column(name, limit))
  .join(',');
export function readRun(store: ReadStore, runId: string): RunRecord | undefined {
  identity(runId, 'run ID');
  const row = store.db.query<Record<string, unknown>>(
    `SELECT ${FIELDS},conversation_revision,model_requests,tool_calls,output_reserved,event_sequence,event_bytes,trace_bytes,created_at,updated_at
    FROM loom_runs WHERE project=? AND agent=? AND id=?`,
    [...store.scope, runId],
  )[0];
  if (!row) return undefined;
  const request = checkedRequest(
    decode(row.request_json, row.request_hash, 1179648) as never,
    'unused',
  );
  if (request.runId !== runId || request.conversationId !== row.conversation_id)
    throw new Error('Stored dialogue request identity mismatch');
  const state = row.state as RunRecord['state'];
  if (!['running', 'interrupted', 'completed'].includes(state))
    throw new Error('Invalid stored run state');
  const result = optional(row, 'result', 524288);
  if ((state === 'completed') !== (result !== null))
    throw new Error('Stored completion is inconsistent');
  const revision = count(row.conversation_revision, 'conversation revision');
  if (!revision) throw new Error('Invalid stored conversation revision');
  return {
    request,
    state,
    revision,
    config: objectValue(decode(row.config_json, row.config_hash, 262144)),
    progress: progressValue(decode(row.progress_json, row.progress_hash, 2097152)),
    verification: verificationValue(optional(row, 'verification', 16384)),
    result: result === null ? null : resultValue(result, request.runId, request.conversationId),
    modelRequests: count(row.model_requests, 'model requests', 256),
    toolCalls: count(row.tool_calls, 'tool calls', MAX_TOOL_CALLS),
    outputReserved: count(row.output_reserved, 'reserved output', 1048576),
    eventSequence: count(row.event_sequence, 'event sequence', 65536),
    eventBytes: count(row.event_bytes, 'event bytes', 16777216),
    traceBytes: count(row.trace_bytes, 'trace bytes', 67108864),
    createdAt: count(row.created_at, 'creation time'),
    updatedAt: count(row.updated_at, 'update time'),
    error: row.error === null ? null : textValue(row.error, 'stored error', MAX_ERROR_BYTES),
  };
}
function optional(row: Record<string, unknown>, prefix: string, maximum: number) {
  if (row[`${prefix}_json`] === null && row[`${prefix}_hash`] === null) return null;
  return decode(row[`${prefix}_json`], row[`${prefix}_hash`], maximum);
}
function resultValue(raw: unknown, runId: string, conversationId: string): LoomResult {
  const row = objectValue(raw),
    budget = objectValue(row.budget),
    lifecycle = objectValue(row.lifecycle);
  if (
    row.runId !== runId ||
    row.conversationId !== conversationId ||
    typeof row.success !== 'boolean' ||
    typeof row.cached !== 'boolean'
  )
    throw new Error('Invalid stored result identity');
  if (
    typeof lifecycle.success !== 'boolean' ||
    !Array.isArray(lifecycle.phases) ||
    lifecycle.phases.length > 4
  )
    throw new Error('Invalid stored lifecycle receipt');
  return {
    runId,
    conversationId,
    success: row.success,
    error: row.error === null ? null : textValue(row.error, 'result error', MAX_ERROR_BYTES),
    cached: row.cached,
    output: textValue(row.output, 'stored output', 131072),
    modifiedFiles: strings(row.modifiedFiles, 1024, 4096),
    verification: verificationValue(row.verification),
    lifecycle: lifecycle as unknown as LoomResult['lifecycle'],
    experienceId: identity(row.experienceId, 'experience ID'),
    checkpointId: row.checkpointId === null ? null : identity(row.checkpointId, 'checkpoint ID'),
    budget: {
      modelRequests: count(budget.modelRequests, 'model requests', 256),
      toolCalls: count(budget.toolCalls, 'tool calls', MAX_TOOL_CALLS),
      outputTokensReserved: count(budget.outputTokensReserved, 'reserved output', 1048576),
      generations: count(budget.generations, 'generations', 32),
      failures: count(budget.failures, 'failures', MAX_TOOL_CALLS),
    },
  };
}
