// Hecaton owns authorization and effect reconciliation; Loom records the ordered dialogue around each receipt.
import type { JsonObject, ToolResult, ToolView } from 'n2-hecaton';
import { boundedCallback, freezeJson } from './callback';
import { DISCOVERY } from './catalog';
import { completeTool, prepareTool } from './tool-store';
import { resultValue } from './record-values';
import { objectValue } from './model-validation';
import { fingerprint } from './values';
import { dialogueContext, type DialogueSession } from './session';
import type { DialogueProgress } from './run-types';
import type { ModelCall } from 'n2-gumiho';

export async function toolTurn(session: DialogueSession): Promise<void> {
  const { run, catalog } = session,
    row = run.get(),
    progress = row.progress;
  const turn = progress.turn;
  const call = progress.lastReply?.calls[progress.nextTool];
  if (!call) throw new Error('Dialogue tool call is missing');
  const view = catalog.tools.get(call.name);
  const input = {
    name: call.name,
    arguments: call.arguments,
    definitionHash: view?.definitionHash ?? null,
  };
  const record = prepareTool(run, progress.turn, progress.nextTool, input);
  if (record.result) throw new Error('Completed tool receipt has inconsistent dialogue progress');
  if (!session.hecaton.status(record.requestId)?.call.result)
    await session.events.emit('tool_call', {
      turn: progress.turn,
      position: progress.nextTool,
      requestId: record.requestId,
      name: call.name,
    });
  let result = await outcome(session, call, view, record.requestId, progress);
  session.signal.throwIfAborted();
  result = resultValue(result);
  const position = progress.nextTool;
  progress.messages.push({
    role: 'tool',
    callId: call.id,
    name: call.name,
    result,
    ...(call.metadata === undefined ? {} : { metadata: call.metadata }),
  });
  progress.nextTool++;
  progress.toolRequestIds.push(record.requestId);
  progress.failures += result.success ? 0 : 1;
  mergeFiles(progress, result.modifiedFiles ?? []);
  if (progress.nextTool >= progress.lastReply!.calls.length && progress.phase !== 'finished') {
    progress.phase = 'model';
    progress.turn++;
  }
  const event = completeTool(run, turn, position, result, progress);
  await session.events.deliver(event);
}
async function outcome(
  session: DialogueSession,
  call: ModelCall,
  view: ToolView | undefined,
  requestId: string,
  progress: DialogueProgress,
): Promise<ToolResult> {
  if (call.name === DISCOVERY.name) {
    try {
      const found = session.catalog.discover(call.arguments, progress.selectedTools);
      progress.selectedTools = found.selected;
      return found.result;
    } catch {
      return { success: false, output: 'Tool discovery requires a valid task or exact tool name' };
    }
  }
  if (!view) return { success: false, output: 'Requested tool is not registered' };
  return invoke(session, view, objectValue(call.arguments), requestId);
}
async function invoke(
  session: DialogueSession,
  tool: ToolView,
  args: JsonObject,
  requestId: string,
): Promise<ToolResult> {
  const previous = session.hecaton.status(requestId);
  if (!previous?.call.result && !(await confirm(session, tool, args, requestId)))
    return { success: false, output: 'Tool confirmation was declined or expired' };
  if (!previous?.call.result)
    await session.events.emit('tool_start', { requestId, name: tool.name });
  const receipt = await session.hecaton.execute(
    {
      requestId,
      sessionId: session.run.get().request.conversationId,
      tool: tool.name,
      arguments: args,
    },
    session.signal,
  );
  return receipt.result;
}
async function confirm(
  session: DialogueSession,
  tool: ToolView,
  args: JsonObject,
  requestId: string,
): Promise<boolean> {
  const hook = session.config.confirmation;
  if (!hook || tool.readOnly) return true;
  const expiresAt = Date.now() + session.run.limits.confirmationTimeoutMs;
  const id = `confirm:${fingerprint({ requestId, definitionHash: tool.definitionHash, arguments: args, expiresAt }, 131072)}`;
  await session.events.emit('tool_confirm', { id, requestId, name: tool.name, expiresAt });
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return false;
  try {
    return await boundedCallback(
      async (signal) => {
        const accepted = await hook.request(
          Object.freeze({
            ...dialogueContext(session, signal),
            id,
            toolRequestId: requestId,
            tool: freezeJson(structuredClone(tool)),
            arguments: freezeJson(structuredClone(args)),
            expiresAt,
          }),
        );
        signal.throwIfAborted();
        return accepted === true && Date.now() < expiresAt;
      },
      remaining,
      session.signal,
      'Tool confirmation',
    );
  } catch {
    session.signal.throwIfAborted();
    return false;
  }
}
function mergeFiles(progress: DialogueProgress, files: string[]): void {
  const merged = [...new Set([...progress.modifiedFiles, ...files])];
  let bytes = 2;
  progress.modifiedFiles = [];
  for (const file of merged) {
    bytes += Buffer.byteLength(JSON.stringify(file)) + 1;
    if (bytes > 65536 || progress.modifiedFiles.length >= 1024) {
      progress.phase = 'finished';
      progress.success = false;
      progress.error =
        'Changed-file summary limit reached. Complete file reports remain in tool receipts.';
      return;
    }
    progress.modifiedFiles.push(file);
  }
}
