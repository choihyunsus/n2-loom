// Snapshot capability metadata while retaining the receiver of class-based host callbacks.
import type { ModelProvider, ModelRequest } from 'n2-gumiho';
import type { JsonObject, ToolView } from 'n2-hecaton';
import type {
  LoomOptions,
  DialoguePreparation,
  DialogueVerifier,
  DialogueConfirmation,
} from './run-types';
import type { StreamingProvider, TextSink } from './stream-types';
import { checkedLimits } from './limits';
import { objectValue } from './model-validation';
import { identity, textValue, plainJson } from './values';
export interface RuntimeConfig {
  providers: Map<string, StreamingProvider>;
  defaultProvider: string;
  preparation?: DialoguePreparation;
  verifier?: DialogueVerifier;
  confirmation?: DialogueConfirmation;
  limits: ReturnType<typeof checkedLimits>;
}
export function configuration(options: LoomOptions): RuntimeConfig {
  if (
    (options.providers !== undefined && !Array.isArray(options.providers)) ||
    (options.providers?.length ?? 0) > 15
  )
    throw new Error('Loom supports at most 16 configured providers');
  const providers = new Map<string, StreamingProvider>();
  for (const raw of [options.provider, ...(options.providers ?? [])]) {
    const provider = checkedProvider(raw);
    if (providers.has(provider.id)) throw new Error('Duplicate provider ID');
    providers.set(provider.id, provider);
  }
  return {
    providers,
    defaultProvider: checkedProvider(options.provider).id,
    limits: checkedLimits(options.limits),
    preparation:
      options.preparation === undefined
        ? undefined
        : {
            version: identity(options.preparation?.version, 'preparation version'),
            prepare: bound(options.preparation, 'prepare'),
          },
    verifier:
      options.verifier === undefined
        ? undefined
        : {
            version: identity(options.verifier?.version, 'verifier version'),
            verify: bound(options.verifier, 'verify'),
          },
    confirmation:
      options.confirmation === undefined
        ? undefined
        : {
            version: identity(options.confirmation?.version, 'confirmation version'),
            request: bound(options.confirmation, 'request'),
          },
  };
}
function bound<T, K extends keyof T>(host: T, name: K): T[K] {
  const callback = host?.[name];
  if (typeof callback !== 'function') throw new Error(`Missing host callback ${String(name)}`);
  return callback.bind(host) as T[K];
}
function checkedProvider(raw: ModelProvider | StreamingProvider): StreamingProvider {
  if (!raw || typeof raw.local !== 'boolean')
    throw new Error('Provider requires an explicit local flag');
  const candidate = raw as StreamingProvider,
    generate = bound(raw, 'generate');
  const model = textValue(raw.model, 'provider model', 256);
  if (!model.trim()) throw new Error('Provider model is required');
  const stream = candidate.stream === undefined ? undefined : bound(candidate, 'stream');
  if (stream && typeof candidate.textStreaming !== 'boolean')
    throw new Error('Streaming providers must declare textStreaming');
  return Object.freeze({
    id: identity(raw.id, 'provider ID'),
    version: identity(raw.version, 'provider version'),
    model,
    local: raw.local,
    generate,
    textStreaming: stream ? candidate.textStreaming : false,
    stream:
      stream ??
      (async (request: ModelRequest, onText: TextSink) => {
        const reply = await generate(request);
        if (reply.text) await onText(reply.text);
        return reply;
      }),
  });
}
export function configSnapshot(
  config: RuntimeConfig,
  tools: ToolView[],
  policyVersion: string,
): JsonObject {
  return objectValue(
    plainJson(
      {
        version: 'loom-1',
        limits: config.limits,
        policy: identity(policyVersion, 'policy version'),
        preparation: config.preparation?.version ?? 'protocol-1',
        verifier: config.verifier?.version ?? 'protocol-1',
        confirmation: config.confirmation?.version ?? null,
        providers: [...config.providers.values()]
          .map(({ id, version, model, local, textStreaming }) => ({
            id,
            version,
            model,
            local,
            textStreaming,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        tools: tools
          .map(({ name, definitionHash, readOnly }) => ({ name, definitionHash, readOnly }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      },
      262144,
      8192,
    ),
  );
}
