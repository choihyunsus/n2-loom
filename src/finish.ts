// Save the result, shared experience, conversation and terminal events in a single fenced transaction.
import type { RunReceipt } from 'n2-recipe';
import { conversation } from './conversations';
import { appendEvent } from './events';
import { saveCheckpoint, snapshot } from './checkpoints';
import { encode } from './store';
import { utf8Preview } from './values';
import type { RunStore } from './run-store';
import type { HistoryMessage, LoomEvent, LoomResult } from './run-types';
export function finalizeRun(
  run: RunStore,
  lifecycle: RunReceipt,
): { result: LoomResult; events: LoomEvent[] } {
  return run.mutate((row) => {
    const success = lifecycle.success && row.progress.success && row.verification?.success === true;
    const meaningful = Boolean(row.progress.output.trim() || row.progress.toolRequestIds.length);
    const checkpointId = meaningful ? saveCheckpoint(run, snapshot(run, 'final')) : null;
    const result = createResult(run, lifecycle, success, checkpointId);
    const { experienceId } = result;
    if (meaningful) saveHistory(run, result, row.request.message);
    const stored = encode(result, 524288);
    run.charge(Buffer.byteLength(stored.json), true);
    const events = terminalEvents(run, result);
    run.store.db.execute(
      "UPDATE loom_runs SET state='completed',result_json=?,result_hash=?,experience_id=?,checkpoint_id=?,error=NULL,updated_at=? WHERE project=? AND agent=? AND id=?",
      [stored.json, stored.hash, experienceId, checkpointId, Date.now(), ...run.key()],
    );
    return { result, events };
  });
}
function createResult(
  run: RunStore,
  lifecycle: RunReceipt,
  success: boolean,
  checkpointId: string | null,
): LoomResult {
  const row = run.get();
  const experienceId = run.store.memory.insertExperience({
    project: run.store.scope[0],
    agent: run.store.scope[1],
    sessionId: row.request.conversationId,
    type: success ? 'success' : 'failure',
    category: 'loom-dialogue',
    severity: success ? 'info' : 'warning',
    context: utf8Preview(row.request.message, 2048),
    action: `Dialogue run ${row.request.runId}`,
    outcome: JSON.stringify({
      success,
      verificationKind: row.verification?.kind ?? null,
      summary: utf8Preview(row.progress.output, 2048),
      lifecycleExperienceId: lifecycle.experienceId,
      checkpointId,
    }),
    sourceRef: `loom:${row.request.runId}`,
  }).id;
  return {
    runId: row.request.runId,
    conversationId: row.request.conversationId,
    success,
    error: success
      ? null
      : (row.progress.error ?? 'A required lifecycle or verification check failed'),
    output: row.progress.output,
    modifiedFiles: row.progress.modifiedFiles,
    verification: row.verification,
    lifecycle,
    experienceId,
    checkpointId,
    cached: false,
    budget: {
      modelRequests: row.modelRequests,
      toolCalls: row.toolCalls,
      outputTokensReserved: row.outputReserved,
      generations: row.progress.generation,
      failures: row.progress.failures,
    },
  };
}
function terminalEvents(run: RunStore, result: LoomResult): LoomEvent[] {
  const events: LoomEvent[] = [];
  if (result.verification)
    events.push(
      appendEvent(
        run,
        'verified',
        {
          success: result.verification.success,
          kind: result.verification.kind,
          summary: utf8Preview(result.verification.summary, 2048),
        },
        true,
      ),
    );
  events.push(
    appendEvent(
      run,
      'done',
      {
        success: result.success,
        experienceId: result.experienceId,
        checkpointId: result.checkpointId,
        lifecycleRunId: result.lifecycle.runId,
      },
      true,
    ),
  );
  return events;
}
function saveHistory(run: RunStore, result: LoomResult, message: string): void {
  const current = conversation(run.store, result.conversationId);
  if (!current) throw new Error('Dialogue conversation is missing');
  const suffix = `\n[Full output and execution evidence in Loom run ${result.runId}]`;
  const status = result.success
    ? ''
    : '[This run ended unsuccessfully. Consult its execution receipt.]\n';
  const content = status + utf8Preview(result.output, 65000) + suffix;
  const history: HistoryMessage[] = [
    ...current.history,
    { role: 'user', content: message },
    { role: 'assistant', content },
  ].slice(-200) as HistoryMessage[];
  while (Buffer.byteLength(JSON.stringify(history)) > 1048576) history.shift();
  const stored = encode(history, 1048576);
  run.store.db.execute(
    'UPDATE loom_conversations SET history_json=?,history_hash=?,checkpoint_id=?,updated_at=? WHERE project=? AND agent=? AND id=? AND revision=?',
    [
      stored.json,
      stored.hash,
      result.checkpointId,
      Date.now(),
      ...run.store.scope,
      result.conversationId,
      current.revision,
    ],
  );
}
