// Compact mutation receipts link to full immutable records; chunking walks Unicode without an unbounded character array.
import { ReconciliationRequired } from 'n2-hecaton';
import { count } from './record-values';
import { digest } from './store';
import { preview } from './values';
import type { LoomResult } from './run-types';
export const PREVIEW_LENGTH = 1000;
export function resultPreview(result: LoomResult) {
  return {
    runId: result.runId,
    conversationId: result.conversationId,
    success: result.success,
    error: result.error,
    output: preview(result.output, PREVIEW_LENGTH),
    outputTruncated: result.output.length > PREVIEW_LENGTH,
    cached: result.cached,
    verificationKind: result.verification?.kind ?? null,
    experienceId: result.experienceId,
    checkpointId: result.checkpointId,
    budget: result.budget,
    fullRecord: { tool: 'loom_read', resource: 'run', id: result.runId },
  };
}
export function chunk(value: unknown, offset = 0, limit = 2048) {
  count(offset, 'character offset', 8388608);
  if (!count(limit, 'character limit', 4096)) throw new Error('Chunk limit must be positive');
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json) > 8388608) throw new Error('Record exceeds the bounded read size');
  let total = 0,
    text = '';
  for (const character of json) {
    if (total >= offset && total < offset + limit) text += character;
    total++;
  }
  return {
    encoding: 'json',
    sha256: digest(json),
    text,
    offset,
    totalCharacters: total,
    hasMore: offset + limit < total,
  };
}
export async function respond(operation: () => unknown | Promise<unknown>) {
  try {
    const value = (await operation()) ?? null,
      text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 60000)
      throw new Error('Response exceeds 60,000 bytes; use smaller pages or loom_read');
    return {
      isError: Boolean(
        value && typeof value === 'object' && 'success' in value && value.success === false,
      ),
      content: [{ type: 'text' as const, text }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: preview(
              error instanceof Error ? error.message : 'Loom operation failed',
              PREVIEW_LENGTH,
            ),
            ...(error instanceof ReconciliationRequired
              ? { requestId: error.requestId, needsReconciliation: true }
              : {}),
          }),
        },
      ],
    };
  }
}
