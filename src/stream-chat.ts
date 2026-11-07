// Chat Completions retains ordered function argument fragments until a checked finish and DONE marker.
import { ProviderError } from 'n2-gumiho';
import { arrayValue, objectValue, type JsonObject } from './model-validation';
import { textValue } from './values';
import { appendText, blockIndex } from './stream-blocks';
import type { StreamDecoder, StreamStep } from './stream-types';

export class ChatDecoder implements StreamDecoder {
  private readonly message: JsonObject = { role: 'assistant', content: '' };
  private readonly calls = new Map<number, JsonObject>();
  private model?: string;
  private reason: string | null = null;
  private usage: JsonObject = {};
  accept(event: JsonObject): StreamStep {
    if (event.type === '[DONE]') return { completed: this.complete() };
    if (event.error) throw new ProviderError('upstream_stream_error');
    if (event.model !== undefined) {
      const model = textValue(event.model, 'response model', 256);
      if (this.model !== undefined && this.model !== model)
        throw new Error('Response model changed inside stream');
      this.model = model;
    }
    if (event.usage !== undefined && event.usage !== null) this.usage = objectValue(event.usage);
    const choices = arrayValue(event.choices, 1);
    if (!choices.length) return {};
    const choice = objectValue(choices[0]);
    if (choice.index !== 0 || this.reason !== null)
      throw new Error('Invalid or repeated completed model choice');
    const delta = objectValue(choice.delta);
    if (delta.role !== undefined && delta.role !== 'assistant')
      throw new Error('Invalid streamed role');
    const text =
      delta.content === undefined || delta.content === null
        ? ''
        : appendText(this.message, 'content', delta.content);
    for (const field of ['refusal', 'reasoning_content', 'reasoning'])
      if (delta[field] !== undefined && delta[field] !== null)
        appendText(this.message, field, delta[field]);
    if (delta.tool_calls !== undefined) this.updateCalls(arrayValue(delta.tool_calls, 16));
    if (choice.finish_reason !== undefined && choice.finish_reason !== null)
      this.reason = textValue(choice.finish_reason, 'finish reason', 128);
    return { delta: text };
  }
  private updateCalls(values: ReturnType<typeof arrayValue>): void {
    for (const raw of values) {
      const value = objectValue(raw),
        index = blockIndex(value.index);
      if (index >= 16) throw new Error('Too many streamed tool calls');
      const prior = this.calls.get(index) ?? { type: 'function', function: { arguments: '' } };
      if (value.type !== undefined && value.type !== 'function')
        throw new Error('Unsupported streamed tool type');
      if (value.id !== undefined) assignStable(prior, 'id', value.id);
      const input = objectValue(value.function),
        output = objectValue(prior.function);
      if (input.name !== undefined) assignStable(output, 'name', input.name);
      if (input.arguments !== undefined) appendText(output, 'arguments', input.arguments, 65536);
      this.calls.set(index, prior);
    }
  }
  private complete(): JsonObject {
    if (this.reason === null) throw new Error('Missing streamed finish reason');
    const calls = [];
    for (let index = 0; index < this.calls.size; index++) {
      const call = this.calls.get(index);
      if (!call) throw new Error('Noncontiguous streamed calls');
      calls.push(call);
    }
    return {
      ...(this.model === undefined ? {} : { model: this.model }),
      usage: this.usage,
      choices: [{ finish_reason: this.reason, message: { ...this.message, tool_calls: calls } }],
    };
  }
}
function assignStable(target: JsonObject, key: string, raw: unknown): void {
  const value = textValue(raw, `tool ${key}`, 128);
  if (target[key] !== undefined && target[key] !== value)
    throw new Error('Streamed tool identity changed');
  target[key] = value;
}
