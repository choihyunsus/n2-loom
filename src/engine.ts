// A logical dialogue keeps cumulative budgets through all model turns and context generations.
import { ReconciliationRequired, type ToolResult } from 'n2-hecaton';
import { DialogueBudgetError, TRACE_RESERVE } from './budget';
import { modelTurn } from './model-turn';
import { toolTurn } from './tool-turn';
import { toolRecord } from './tool-store';
import { utf8Preview } from './values';
import type { DialogueSession } from './session';
export async function executeDialogue(
  session: DialogueSession,
  additions: readonly string[],
): Promise<ToolResult> {
  for (;;) {
    session.signal.throwIfAborted();
    const row = session.run.get();
    if (row.progress.phase === 'finished') return workResult(session);
    try {
      checkBudget(session);
      if (row.progress.phase === 'model') await modelTurn(session, additions);
      else await toolTurn(session);
    } catch (error) {
      if (!(error instanceof DialogueBudgetError)) throw error;
      const progress = session.run.get().progress;
      progress.phase = 'finished';
      progress.success = false;
      progress.error = error.message;
      session.run.saveProgress(progress, true);
    }
  }
}
function checkBudget(session: DialogueSession): void {
  const { run } = session,
    row = run.get(),
    progress = row.progress,
    limit = run.limits;
  if (progress.phase === 'tools') {
    const pending = toolRecord(run, progress.turn, progress.nextTool);
    const status = pending ? session.hecaton.status(pending.requestId) : undefined;
    if (status?.needsReconciliation) throw new ReconciliationRequired(pending!.requestId);
    if (status?.call.result) return;
  }
  if (row.createdAt + limit.runTimeoutMs <= Date.now())
    throw new DialogueBudgetError('Dialogue wall-clock execution budget exhausted');
  if (progress.failures >= limit.maxFailures)
    throw new DialogueBudgetError('Dialogue failed-tool budget exhausted');
  if (progress.turn >= limit.maxTurns)
    throw new DialogueBudgetError('Dialogue turn budget exhausted');
  if (
    row.eventSequence >= limit.maxEvents - 8 ||
    row.eventBytes >= limit.maxEventBytes - 131072 ||
    row.traceBytes >= limit.maxTraceBytes - TRACE_RESERVE
  )
    throw new DialogueBudgetError('Dialogue recording budget exhausted');
}
function workResult(session: DialogueSession): ToolResult {
  const row = session.run.get(),
    progress = row.progress;
  return {
    success: progress.success,
    output: utf8Preview(progress.output || progress.error || 'Dialogue finished', 2000),
    modifiedFiles: progress.modifiedFiles,
    data: {
      runId: row.request.runId,
      fullOutput: 'loom_runs.result_json',
      modelRequests: row.modelRequests,
      toolCalls: row.toolCalls,
      error: progress.error,
    },
  };
}
