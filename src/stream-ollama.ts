// Native Ollama chat emits complete tool calls within NDJSON chunks and one final statistics record.
import { ProviderError } from 'n2-gumiho';
import { arrayValue, objectValue, type JsonObject } from './model-validation';
import { textValue } from './values';
import { appendText } from './stream-blocks';
import type { StreamDecoder, StreamStep } from './stream-types';
const MAX_CALLS = 16;

export class OllamaDecoder implements StreamDecoder {
  private readonly message: JsonObject = { role: 'assistant', content: '', tool_calls: [] };
  private model?: string;
  constructor(private readonly jsonEnvelope = false) {}
  accept(event: JsonObject): StreamStep {
    if (event.error) throw new ProviderError('upstream_stream_error');
    const message = objectValue(event.message);
    if (message.role !== 'assistant' || typeof event.done !== 'boolean')
      throw new Error('Invalid Ollama stream message');
    const model = textValue(event.model, 'response model', 256);
    if (this.model !== undefined && this.model !== model)
      throw new Error('Response model changed inside stream');
    this.model = model;
    const delta = appendText(this.message, 'content', message.content ?? '');
    if (message.thinking !== undefined) appendText(this.message, 'thinking', message.thinking);
    this.message.tool_calls = [
      ...arrayValue(this.message.tool_calls, MAX_CALLS),
      ...arrayValue(message.tool_calls ?? [], MAX_CALLS),
    ];
    arrayValue(this.message.tool_calls, MAX_CALLS);
    return {
      ...(this.jsonEnvelope ? {} : { delta }),
      ...(event.done ? { completed: { ...event, message: this.message } } : {}),
    };
  }
}
