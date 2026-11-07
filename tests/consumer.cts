import { Loom, inspectLoom, ollamaChat, type StreamingProvider, type LoomObserver } from '..';
import type { ModelProvider } from 'n2-gumiho';
const provider: StreamingProvider = ollamaChat({
  id: 'local',
  model: 'installed-model',
  think: false,
});
const compatible: ModelProvider = provider;
const engine = new Loom({
  dbPath: './mimir.db',
  project: 'example',
  agent: 'worker',
  provider,
  tools: [
    {
      name: 'echo',
      version: '1',
      description: 'Return text',
      readOnly: true,
      inputSchema: { type: 'object' },
      execute: (args, context) => ({
        success: !context.signal.aborted,
        output: JSON.stringify(args),
      }),
    },
  ],
  verifier: {
    version: '1',
    verify: (context) => ({
      success: !context.signal.aborted,
      summary: context.output,
      evidence: { failures: context.failures },
    }),
  },
});
const observer: LoomObserver = {
  onEvent(event) {
    void event.replay;
  },
};
const result = engine.run(
  { runId: 'one', conversationId: 'conversation', message: 'hello' },
  observer,
);
const inspected = inspectLoom({
  dbPath: './mimir.db',
  project: 'example',
  agent: 'worker',
  view: 'history',
});
void [
  compatible,
  result,
  inspected,
  engine.history(),
  engine.mcpServers(),
  engine.cancel('one'),
  engine.close(),
];
