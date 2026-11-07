// Reject malformed stored state even when a row has a syntactically valid JSON hash.
import type { ToolResult } from 'n2-hecaton';
import type { ModelMessage } from 'n2-gumiho';
import { checkedResult } from 'n2-hecaton/dist/tool-entry';
import { checkedReply, objectValue, arrayValue, checkHistory } from './model-validation';
import { identity, plainJson, textValue } from './values';
import type { DialogueProgress, LoomResult } from './run-types';

export function count(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`Invalid stored ${label}`);
  return value;
}
export function strings(value: unknown, maximum: number, bytes: number): string[] {
  return arrayValue(value, maximum).map((item) => textValue(item, 'stored string', bytes));
}
export function resultValue(value: unknown): ToolResult {
  return checkedResult(value, false);
}
export function messagesValue(value: unknown, partial = false): ModelMessage[] {
  const messages = arrayValue(value, 512).map((item): ModelMessage => {
    const row = objectValue(item);
    if (row.role === 'user')
      return { role: 'user', content: textValue(row.content, 'message', 131072) };
    if (row.role === 'assistant')
      return { role: 'assistant', reply: checkedReply(row.reply as never) };
    if (row.role !== 'tool') throw new Error('Invalid stored message role');
    return {
      role: 'tool',
      callId: identity(row.callId, 'tool call ID'),
      name: identity(row.name, 'tool name'),
      result: resultValue(row.result),
      ...(row.metadata === undefined ? {} : { metadata: plainJson(row.metadata) }),
    };
  });
  const completed = [...messages];
  if (partial) {
    let lastAssistant = messages.length - 1;
    while (lastAssistant >= 0 && messages[lastAssistant]?.role !== 'assistant') lastAssistant--;
    const assistant = messages[lastAssistant];
    if (assistant?.role === 'assistant') {
      const answered = new Set(
        messages
          .slice(lastAssistant + 1)
          .flatMap((item) => (item.role === 'tool' ? [item.callId] : [])),
      );
      for (const call of assistant.reply.calls)
        if (!answered.has(call.id))
          completed.push({
            role: 'tool',
            callId: call.id,
            name: call.name,
            result: { success: false, output: 'Pending' },
          });
    }
  }
  checkHistory(completed);
  return messages;
}
export function progressValue(value: unknown): DialogueProgress {
  const row = objectValue(value);
  if (
    !['model', 'tools', 'finished'].includes(row.phase as string) ||
    typeof row.success !== 'boolean'
  )
    throw new Error('Invalid stored dialogue progress');
  const result: DialogueProgress = {
    phase: row.phase as DialogueProgress['phase'],
    turn: count(row.turn, 'turn', 128),
    generation: count(row.generation, 'generation', 32),
    nextTool: count(row.nextTool, 'tool index', 16),
    messages: messagesValue(
      row.messages,
      row.phase === 'tools' || (row.phase === 'finished' && row.error !== null),
    ),
    lastReply: row.lastReply === null ? null : checkedReply(row.lastReply as never),
    output: textValue(row.output, 'dialogue output', 131072),
    modifiedFiles: strings(row.modifiedFiles, 1024, 4096),
    toolRequestIds: strings(row.toolRequestIds, 512, 128),
    failures: count(row.failures, 'failures', 512),
    lastSignature:
      row.lastSignature === null ? null : textValue(row.lastSignature, 'batch signature', 64),
    selectedTools: strings(row.selectedTools, 32, 128),
    success: row.success,
    error: row.error === null ? null : textValue(row.error, 'progress error', 1024),
  };
  if (
    !result.generation ||
    (result.phase === 'tools' &&
      (result.lastReply?.stop !== 'tools' || result.nextTool > result.lastReply.calls.length))
  )
    throw new Error('Stored tool progress is inconsistent');
  return result;
}
export function verificationValue(value: unknown): LoomResult['verification'] {
  if (value === null) return null;
  const row = objectValue(plainJson(value, 16384));
  if (typeof row.success !== 'boolean' || !['protocol', 'host'].includes(row.kind as string))
    throw new Error('Invalid dialogue verification');
  return {
    success: row.success,
    summary: textValue(row.summary, 'verification summary', 8192),
    kind: row.kind as 'protocol' | 'host',
    ...(row.evidence === undefined ? {} : { evidence: objectValue(row.evidence) }),
  };
}
