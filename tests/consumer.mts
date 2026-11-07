import { Loom, inspectLoom, openAIResponses, type StreamingProvider } from '../dist/library.js';
import type { ModelProvider } from 'n2-gumiho';
const provider: StreamingProvider = openAIResponses({
  id: 'cloud',
  model: 'configured-model',
  apiKey: 'fixture-key',
});
const compatible: ModelProvider = provider;
const engine = new Loom({ dbPath: './mimir.db', project: 'example', agent: 'worker', provider });
const result = engine.run({ runId: 'one', conversationId: 'chat', message: 'hello' });
const inspected = inspectLoom({
  dbPath: './mimir.db',
  project: 'example',
  agent: 'worker',
  view: 'status',
  runId: 'one',
});
void [compatible, result, inspected, engine.close()];
