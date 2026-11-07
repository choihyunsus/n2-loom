// One live operation owns callbacks and the durable state of one logical dialogue.
import type { Hecaton } from 'n2-hecaton';
import type { RunStore } from './run-store';
import type { RuntimeConfig } from './config';
import type { DialogueCatalog } from './catalog';
import type { EventObserver } from './observer';
import type { StreamingProvider } from './stream-types';
import type { DialogueContext } from './run-types';
export interface DialogueSession {
  run: RunStore;
  config: RuntimeConfig;
  catalog: DialogueCatalog;
  hecaton: Hecaton;
  provider: StreamingProvider;
  events: EventObserver;
  signal: AbortSignal;
}
export function dialogueContext(
  session: DialogueSession,
  signal = session.signal,
): DialogueContext {
  const request = session.run.get().request;
  return Object.freeze({
    project: session.run.store.scope[0],
    agent: session.run.store.scope[1],
    runId: request.runId,
    conversationId: request.conversationId,
    message: request.message,
    signal,
  });
}
