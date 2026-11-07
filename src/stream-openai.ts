// Responses final objects remain authoritative while visible deltas retain their ordered content parts.
import { ProviderError } from 'n2-gumiho';
import { objectValue } from './model-validation';
import { textValue } from './values';
import { blockIndex } from './stream-blocks';
import type { JsonObject } from './model-validation';
import type { StreamDecoder, StreamStep } from './stream-types';

export class ResponsesDecoder implements StreamDecoder {
  private readonly parts = new Set<string>();
  private lastPart = '';
  accept(event: JsonObject): StreamStep {
    const type = textValue(event.type, 'stream event type', 256);
    if (type === 'error' || type === 'response.failed')
      throw new ProviderError('upstream_stream_error');
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = objectValue(event.response);
      if (response.status !== (type === 'response.completed' ? 'completed' : 'incomplete'))
        throw new Error('Conflicting response completion status');
      return { completed: response };
    }
    if (type !== 'response.output_text.delta') return {};
    blockIndex(event.output_index);
    blockIndex(event.content_index);
    const key = `${event.output_index}:${event.content_index}`;
    const delta = textValue(event.delta, 'text delta', 131072);
    if (this.parts.has(key) && key !== this.lastPart)
      throw new Error('Interleaved text parts require a structured stream host');
    const separator = !this.parts.has(key) && this.parts.size > 0 ? '\n' : '';
    this.parts.add(key);
    this.lastPart = key;
    return { delta: separator + delta };
  }
}
