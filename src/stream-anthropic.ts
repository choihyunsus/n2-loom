// Reconstruct Messages content and cumulative usage while exposing only text block deltas.
import { ProviderError } from 'n2-gumiho';
import { arrayValue, objectValue, type JsonObject } from './model-validation';
import { textValue } from './values';
import { StreamBlocks, appendText } from './stream-blocks';
import type { StreamDecoder, StreamStep } from './stream-types';

export class MessagesDecoder implements StreamDecoder {
  private message?: JsonObject;
  private readonly blocks = new StreamBlocks();
  private textBlocks = 0;
  accept(event: JsonObject): StreamStep {
    const type = textValue(event.type, 'stream event type', 256);
    if (type === 'error') throw new ProviderError('upstream_stream_error');
    if (type === 'message_start') {
      if (this.message) throw new Error('Duplicate message start');
      this.message = objectValue(event.message);
      if (
        this.message.type !== 'message' ||
        this.message.role !== 'assistant' ||
        arrayValue(this.message.content).length
      )
        throw new Error('Invalid streaming message start');
      return {};
    }
    if (type === 'ping') return {};
    if (!this.message) throw new Error('Stream event preceded message start');
    if (type === 'content_block_start') return this.start(event);
    if (type === 'content_block_delta') return this.delta(event);
    if (type === 'content_block_stop') {
      this.blocks.stop(event.index, 'input');
      return {};
    }
    if (type === 'message_delta') this.update(event);
    if (type === 'message_stop') {
      if (typeof this.message.stop_reason !== 'string')
        throw new Error('Missing message stop reason');
      return { completed: { ...this.message, content: this.blocks.complete() } };
    }
    return {};
  }
  private start(event: JsonObject): StreamStep {
    const block = this.blocks.start(event.index, event.content_block);
    if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(String(block.type)))
      throw new Error('Unsupported streamed content block');
    if (block.type !== 'text') return {};
    const separator = this.textBlocks++ > 0 ? '\n' : '';
    return { delta: separator + textValue(block.text ?? '', 'initial block text', 131072) };
  }
  private delta(event: JsonObject): StreamStep {
    const block = this.blocks.current(event.index).value;
    const delta = objectValue(event.delta);
    if (delta.type === 'text_delta' && block.type === 'text')
      return { delta: appendText(block, 'text', delta.text) };
    if (delta.type === 'input_json_delta' && block.type === 'tool_use')
      this.blocks.arguments(event.index, delta.partial_json);
    else if (delta.type === 'thinking_delta' && block.type === 'thinking')
      appendText(block, 'thinking', delta.thinking);
    else if (delta.type === 'signature_delta' && block.type === 'thinking')
      appendText(block, 'signature', delta.signature, 262144);
    else if (delta.type === 'citations_delta' && block.type === 'text')
      block.citations = [...arrayValue(block.citations ?? [], 128), objectValue(delta.citation)];
    else throw new Error('Unsupported delta for this content block');
    return {};
  }
  private update(event: JsonObject): void {
    this.message = { ...this.message!, ...objectValue(event.delta) };
    const usage = { ...objectValue(this.message!.usage ?? {}) };
    for (const [key, value] of Object.entries(objectValue(event.usage ?? {})))
      if (value !== null)
        Object.defineProperty(usage, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    this.message!.usage = usage;
  }
}
