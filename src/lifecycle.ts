// Use the published lifecycle runner for required preconditions, work, verification and checkpointing.
import { RecipeRunner, type ToolDefinition, type RunReceipt } from 'n2-recipe';
import { boundedCallback, freezeJson } from './callback';
import { executeDialogue } from './engine';
import { resultValue, verificationValue } from './record-values';
import { dialogueContext, type DialogueSession } from './session';
import { fingerprint, utf8Preview } from './values';

export async function lifecycle(session: DialogueSession): Promise<RunReceipt> {
  const { run } = session,
    request = run.get().request;
  const runner = new RecipeRunner({
    dbPath: run.store.dbPath,
    project: run.store.scope[0],
    agent: run.store.scope[1],
    tools: lifecycleTools(session),
    deadlines: {
      toolMs: run.limits.modelTimeoutMs,
      phaseMs: run.limits.runTimeoutMs,
      workMs: run.limits.runTimeoutMs,
    },
  });
  try {
    const runId = `loom:${fingerprint({ storage: run.store.storageId, scope: run.store.scope, run: request.runId })}`;
    return await runner.run(
      { runId, sessionId: request.conversationId, task: request.message },
      {
        version: 'loom-dialogue-1',
        idempotent: true,
        execute: (context) =>
          executeDialogue({ ...session, signal: context.signal }, [
            ...context.context.systemAdditions,
            ...context.context.userAdditions,
          ]),
      },
      session.signal,
    );
  } finally {
    await runner.close();
  }
}
function lifecycleTools(session: DialogueSession): ToolDefinition[] {
  return [
    {
      name: 'prepare',
      version: session.config.preparation?.version ?? 'loom-protocol-1',
      readOnly: true,
      idempotent: true,
      execute: async (_, context) => {
        if (session.hecaton.problems().length)
          return {
            success: false,
            output: 'Configured tool definitions require repair before dialogue execution',
          };
        const hook = session.config.preparation;
        if (!hook)
          return {
            success: true,
            output: 'Provider, scoped storage, budgets and registered tools are ready',
          };
        try {
          const result = await boundedCallback(
            (signal) => hook.prepare(dialogueContext(session, signal)),
            session.run.limits.modelTimeoutMs,
            context.signal,
            'Preparation',
          );
          return resultValue(result);
        } catch {
          throw new Error('Host preparation failed or exceeded its deadline');
        }
      },
    },
    {
      name: 'verify',
      version: session.config.verifier?.version ?? 'loom-protocol-1',
      readOnly: true,
      idempotent: true,
      execute: async (_, context) => {
        const result = await verify(session, context.signal);
        return { success: result!.success, output: utf8Preview(result!.summary, 8192) };
      },
    },
  ];
}
async function verify(session: DialogueSession, parent: AbortSignal) {
  const { run, config } = session,
    row = run.get();
  if (row.verification) return row.verification;
  const progress = row.progress;
  let result = {
    success: progress.phase === 'finished' && progress.success && progress.failures === 0,
    summary:
      progress.error ??
      'Protocol completion and recorded tool outcomes were checked. Content accuracy requires a host verifier.',
  };
  if (config.verifier) {
    try {
      result = await boundedCallback(
        (signal) =>
          config.verifier!.verify(
            Object.freeze({
              ...dialogueContext(session, signal),
              output: progress.output,
              modifiedFiles: freezeJson([...progress.modifiedFiles]),
              failures: progress.failures,
              toolRequestIds: freezeJson([...progress.toolRequestIds]),
            }),
          ),
        run.limits.modelTimeoutMs,
        parent,
        'Verification',
      );
    } catch {
      throw new Error('Host verification failed or exceeded its deadline');
    }
  }
  parent.throwIfAborted();
  const verified = verificationValue({
    ...result,
    kind: config.verifier ? 'host' : 'protocol',
  });
  verified!.success = verified!.success && progress.phase === 'finished' && progress.success;
  run.saveVerification(verified);
  return verified;
}
