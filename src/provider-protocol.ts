// Provider codecs share one real streaming path for buffered and incremental host consumption.
import type { JsonValue, ModelProvider, ModelReply, ModelRequest } from './types';
import { identity, fingerprint, textValue, plainJson } from './values';
import { checkRequest, checkedReply, objectValue, type JsonObject } from './model-validation';
import {
  streamTransport,
  providerEndpoint,
  ProviderError,
  type HttpProviderOptions,
} from './provider-http';
import { ResponsesDecoder } from './stream-openai';
import { MessagesDecoder } from './stream-anthropic';
import { ChatDecoder } from './stream-chat';
import { OllamaDecoder } from './stream-ollama';
import { InteractionsDecoder } from './stream-gemini';
import type { TextSink, StreamDecoder } from './stream-types';

export interface WireProtocol {
  format: string;
  configuration?: JsonValue;
  encode(request: ModelRequest): JsonValue;
  decode(response: JsonObject, request: ModelRequest): ModelReply;
}
export function createWireProvider(
  options: HttpProviderOptions,
  defaultEndpoint: string,
  headers: Record<string, string>,
  protocol: WireProtocol,
  local = false,
): ModelProvider {
  const id = identity(options.id, 'provider ID'),
    model = textValue(options.model, 'provider model', 256);
  if (!model.trim()) throw new Error('An explicit model is required');
  const endpoint = providerEndpoint(options.endpoint ?? defaultEndpoint);
  const transport = streamTransport(endpoint, headers, options);
  const version = `${protocol.format}-stream-1-${fingerprint({ endpoint, model, configuration: protocol.configuration ?? null }).slice(0, 16)}`;
  const stream = createStream(protocol, transport);
  return Object.freeze({
    id,
    version,
    model,
    local,
    textStreaming: protocol.format !== 'ollama-json',
    stream,
    generate: (request: ModelRequest) => stream(request, () => {}),
  });
}
function createStream(protocol: WireProtocol, transport: ReturnType<typeof streamTransport>) {
  return async (request: ModelRequest, onText: TextSink): Promise<ModelReply> => {
    checkRequest(request);
    const body = objectValue(protocol.encode(request));
    body.stream = true;
    const state = decoder(protocol.format);
    let result: ModelReply | undefined;
    let visible = '';
    const framing = protocol.format.startsWith('ollama-') ? 'ndjson' : 'sse';
    await transport(body, request, framing, async (data) => {
      if (data === '') return false;
      const raw =
        data.trim() === '[DONE]'
          ? { type: '[DONE]' }
          : objectValue(plainJson(JSON.parse(data), 2097152, 65536, 32));
      const step = state.accept(raw);
      if (step.delta) {
        visible = textValue(visible + step.delta, 'accumulated visible text', 131072);
        await onText(step.delta);
      }
      if (!step.completed) return false;
      result = checkedReply(protocol.decode(step.completed, request));
      if (
        protocol.format !== 'ollama-json' &&
        ['complete', 'tools'].includes(result.stop) &&
        result.text !== visible
      )
        throw new ProviderError('stream_text_mismatch');
      if (protocol.format === 'ollama-json' && result.text) await onText(result.text);
      return true;
    });
    if (!result) throw new ProviderError('stream_ended_before_completion');
    return result;
  };
}
function decoder(format: string): StreamDecoder {
  if (format === 'openai-responses') return new ResponsesDecoder();
  if (format.startsWith('anthropic-messages-')) return new MessagesDecoder();
  if (format === 'gemini-interactions') return new InteractionsDecoder();
  if (format.startsWith('chat-')) return new ChatDecoder();
  if (format.startsWith('ollama-')) return new OllamaDecoder(format === 'ollama-json');
  throw new Error('Unknown streaming provider format');
}
export function continuation(reply: ModelReply, format: string): JsonValue {
  if (reply.providerState === undefined && reply.stop === 'complete' && !reply.calls.length)
    return historicalText(reply.text, format);
  const state = objectValue(reply.providerState);
  if (state.format !== format || state.value === undefined)
    throw new Error('Missing or incompatible provider continuation state');
  return state.value;
}
function historicalText(text: string, format: string): JsonValue {
  if (format === 'openai-responses')
    return [{ role: 'assistant', content: [{ type: 'output_text', text }] }];
  if (format.startsWith('anthropic-messages-')) return [{ type: 'text', text }];
  if (format === 'gemini-interactions')
    return [{ type: 'model_output', content: [{ type: 'text', text }] }];
  return {
    role: 'assistant',
    content: format === 'ollama-json' ? JSON.stringify({ text, calls: [] }) : text,
  };
}
export function storedState(format: string, value: JsonValue): JsonObject {
  return { format, value };
}
export function jsonArguments(value: unknown): JsonValue {
  return objectValue(JSON.parse(textValue(value, 'function arguments')));
}
