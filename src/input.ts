// Validate owned request data before constructing provider state or opening a dialogue operation.
import { identity, textValue, plainJson } from './values';
import { objectValue } from './model-validation';
import type { CheckedRequest, HistoryMessage, LoomRequest } from './run-types';
export function checkedRequest(value: LoomRequest, defaultProvider: string): CheckedRequest {
  const input = objectValue(value);
  if (
    Object.keys(input).some(
      (key) =>
        !['runId', 'conversationId', 'message', 'mode', 'providerId', 'system', 'history'].includes(
          key,
        ),
    )
  )
    throw new Error('Unknown dialogue request field');
  const row = objectValue(
    plainJson(
      Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined)),
      1179648,
      4096,
    ),
  );
  const message = textValue(row.message, 'user message', 65536);
  if (!message.trim()) throw new Error('An explicit user message is required');
  const mode = row.mode === undefined ? 'agent' : row.mode;
  if (mode !== 'chat' && mode !== 'agent') throw new Error('Unknown dialogue mode');
  return {
    runId: identity(row.runId, 'run ID'),
    conversationId: identity(row.conversationId, 'conversation ID'),
    message,
    mode,
    providerId: identity(
      row.providerId === undefined ? defaultProvider : row.providerId,
      'provider ID',
    ),
    system: textValue(row.system === undefined ? '' : row.system, 'system prompt', 16384),
    history: checkedHistory(row.history === undefined ? [] : row.history),
  };
}
export function checkedHistory(value: unknown): HistoryMessage[] {
  if (!Array.isArray(value) || value.length > 200)
    throw new Error('Conversation history supports at most 200 messages');
  const history = Array.from(value, (raw) => {
    const row = objectValue(raw);
    if (
      Object.keys(row).some((key) => !['role', 'content'].includes(key)) ||
      typeof row.role !== 'string' ||
      !['user', 'assistant'].includes(row.role)
    )
      throw new Error('Historical messages require a user or assistant role');
    return {
      role: row.role as HistoryMessage['role'],
      content: textValue(row.content, 'historical message', 65536),
    };
  });
  if (Buffer.byteLength(JSON.stringify(history)) > 1048576)
    throw new Error('Conversation history exceeds 1 MiB');
  return history;
}
