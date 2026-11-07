// Keep credentials in a fixed endpoint closure and never replay a partially consumed provider stream.
import { setTimeout as delay } from 'node:timers/promises';
import {
  ProviderError,
  type HttpProviderOptions,
  type ModelRequest,
  type JsonValue,
} from 'n2-gumiho';
import { text, integer, plainJson } from 'n2-hecaton/dist/values';
import { StreamFrames } from './stream-frames';

const MAX_BODY = 2097152;
const MAX_STREAM = 16777216;
export type FrameSink = (data: string) => Promise<boolean>;
class AttemptRejected extends Error {
  constructor(readonly reason: unknown) {
    super('Provider attempt rejected by host budget');
  }
}
export function streamTransport(
  endpoint: string,
  headers: Record<string, string>,
  options: HttpProviderOptions,
) {
  const url = checkedEndpoint(endpoint);
  const timeoutMs = integer(options.timeoutMs ?? 120000, 'provider timeout', 1, 3600000);
  const retries = integer(options.retries ?? 1, 'provider retries', 0, 2);
  const requestHeaders = Object.freeze({ ...headers, 'content-type': 'application/json' });
  return async (
    body: JsonValue,
    request: ModelRequest,
    mode: 'sse' | 'ndjson',
    consume: FrameSink,
  ): Promise<void> => {
    request.signal.throwIfAborted();
    const encoded = JSON.stringify(plainJson(body, MAX_BODY, 65536, 32));
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new ProviderError('timeout')), timeoutMs);
    try {
      const response = await send(url, requestHeaders, encoded, retries, request, signal);
      await consumeResponse(response, mode, consume, signal);
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof AttemptRejected) throw error.reason;
      if (controller.signal.aborted) throw new ProviderError('timeout');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('invalid_or_interrupted_stream');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
export function checkedEndpoint(value: unknown): string {
  const raw = text(value, 'provider endpoint', 8192);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid provider endpoint');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Provider endpoint requires HTTPS or loopback HTTP without URL credentials');
  return url.href;
}
export function credential(value: string | undefined, required = true): string {
  const result = text(value ?? '', 'provider credential', 8192);
  if (/[\r\n]/.test(result) || (required && !result.trim()))
    throw new Error('A valid provider credential is required');
  return result;
}
async function send(
  url: string,
  headers: Record<string, string>,
  body: string,
  retries: number,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      request.onAttempt?.();
    } catch (error) {
      throw new AttemptRejected(error);
    }
    const response = await abortable(
      fetch(url, { method: 'POST', headers, body, signal, redirect: 'error' }),
      signal,
    );
    if ((response.status === 429 || response.status === 503) && attempt < retries) {
      void response.body?.cancel().catch(() => undefined);
      await delay(retryDelay(response.headers.get('retry-after'), attempt), undefined, { signal });
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ProviderError('request_failed', response.status);
    }
    return response;
  }
}
function retryDelay(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      if (milliseconds > 30000) throw new ProviderError('retry_later', 429);
      return milliseconds;
    }
  }
  return 250 * (attempt + 1);
}
async function consumeResponse(
  response: Response,
  mode: 'sse' | 'ndjson',
  consume: FrameSink,
  signal: AbortSignal,
): Promise<void> {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const allowed =
    mode === 'sse' ? ['text/event-stream'] : ['application/x-ndjson', 'application/ndjson'];
  if (
    !response.body ||
    !allowed.includes(type ?? '') ||
    Number(response.headers.get('content-length') ?? 0) > MAX_STREAM
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new ProviderError('invalid_stream_response');
  }
  const reader = response.body.getReader();
  const frames = new StreamFrames(mode);
  let bytes = 0,
    count = 0;
  const dispatch = async (data: string): Promise<boolean> => {
    if (++count > 65536) throw new ProviderError('stream_event_budget');
    return abortable(consume(data), signal);
  };
  try {
    for (;;) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) {
        for (const frame of frames.finish()) if (await dispatch(frame)) return;
        throw new ProviderError('stream_ended_before_completion');
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM) throw new ProviderError('stream_byte_budget');
      for (const frame of frames.push(chunk.value)) if (await dispatch(frame)) return;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  const idle = new AbortController();
  const timer = setTimeout(() => idle.abort(new ProviderError('stream_idle_timeout')), 30000);
  try {
    return await abortable(reader.read(), AbortSignal.any([signal, idle.signal]));
  } finally {
    clearTimeout(timer);
  }
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void promise.catch(() => undefined);
  signal.throwIfAborted();
  let cancel = (): void => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
