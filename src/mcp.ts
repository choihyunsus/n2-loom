// A stdio host fixes the provider, database and authorization scope for every MCP operation.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { chunk, respond, resultPreview, PREVIEW_LENGTH } from './mcp-output';
import { preview } from './values';
import type { Loom } from './loom';
const id = z.string().min(1).max(128);
const MAX_TEXT_BYTES = 65536;
const page = {
  limit: z.int().min(1).max(100).default(20),
  offset: z.int().min(0).max(1000000).default(0),
};
export function createMcpServer(engine: Loom): McpServer {
  const server = new McpServer(
    { name: 'n2-loom', version: '1.0.0' },
    { maxToolInputElements: 8192 },
  );
  registerRun(server, engine);
  registerRead(server, engine);
  registerChunks(server, engine);
  registerEvents(server, engine);
  registerHistory(server, engine);
  registerTools(server, engine);
  registerRecovery(server, engine);
  registerReconcile(server, engine);
  return server;
}
function registerRun(server: McpServer, engine: Loom): void {
  server.registerTool(
    'loom_run',
    {
      description:
        'Run or resume one durable dialogue through preparation, tools, verification and shared memory. Keep runId stable for retries.',
      inputSchema: z
        .object({
          runId: id,
          conversationId: id,
          message: z.string().min(1).max(MAX_TEXT_BYTES),
          mode: z.enum(['chat', 'agent']).optional(),
          providerId: id.optional(),
          system: z.string().max(16384).optional(),
          history: z
            .array(
              z
                .object({
                  role: z.enum(['user', 'assistant']),
                  content: z.string().max(MAX_TEXT_BYTES),
                })
                .strict(),
            )
            .max(200)
            .optional(),
        })
        .strict(),
    },
    async (input, extra) =>
      respond(async () => resultPreview(await engine.run(input, { signal: extra.signal }))),
  );
  server.registerTool(
    'loom_cancel',
    {
      description:
        'Cancel the active run with this exact ID. Committed effects and receipts remain inspectable.',
      inputSchema: z.object({ runId: id }).strict(),
    },
    async ({ runId }) => respond(() => ({ cancelled: engine.cancel(runId), runId })),
  );
}
function registerRead(server: McpServer, engine: Loom): void {
  server.registerTool(
    'loom_status',
    {
      description: 'Read the durable phase and outcome summary for one run.',
      inputSchema: z.object({ runId: id }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) =>
      respond(() => {
        const row = engine.status(runId);
        if (!row) return null;
        return {
          runId,
          conversationId: row.request.conversationId,
          state: row.state,
          phase: row.progress.phase,
          turn: row.progress.turn,
          generation: row.progress.generation,
          modelRequests: row.modelRequests,
          toolCalls: row.toolCalls,
          eventSequence: row.eventSequence,
          error: row.error,
          result: row.result ? resultPreview(row.result) : null,
        };
      }),
  );
}
function registerChunks(server: McpServer, engine: Loom): void {
  server.registerTool(
    'loom_read',
    {
      description:
        'Read full run, conversation, tool, tool-call or event JSON in Unicode-character chunks. Compare sha256 across pages.',
      inputSchema: z
        .object({
          resource: z.enum(['run', 'conversation', 'tool', 'tool-call', 'event']),
          id,
          sequence: z.int().min(1).max(65536).optional(),
          offset: z.int().min(0).max(8388608).default(0),
          limit: z.int().min(1).max(4096).default(2048),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      respond(() => {
        const record = readResource(engine, input.resource, input.id, input.sequence);
        if (!record) throw new Error('Requested record was not found in this scope');
        return chunk(record, input.offset, input.limit);
      }),
  );
}
function readResource(
  engine: Loom,
  resource: string,
  identifier: string,
  sequence?: number,
): unknown {
  if (resource === 'run') return engine.status(identifier);
  if (resource === 'conversation') return engine.conversation(identifier);
  if (resource === 'tool') return engine.tools().find((tool) => tool.name === identifier);
  if (resource === 'tool-call') return engine.toolStatus(identifier);
  if (!sequence) throw new Error('An event sequence is required');
  const event = engine.events(identifier, sequence - 1, 1)[0];
  return event?.sequence === sequence ? event : undefined;
}
function registerEvents(server: McpServer, engine: Loom): void {
  server.registerTool(
    'loom_events',
    {
      description:
        'Read event previews after a durable sequence cursor. Full event data is available through loom_read.',
      inputSchema: z
        .object({
          runId: id,
          afterSequence: z.int().min(0).max(65536).default(0),
          limit: z.int().min(1).max(20).default(10),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ runId, afterSequence, limit }) =>
      respond(() => ({
        events: engine.events(runId, afterSequence, limit).map(({ data, ...event }) => ({
          ...event,
          dataPreview: preview(JSON.stringify(data), PREVIEW_LENGTH),
          fullRecord: {
            tool: 'loom_read',
            resource: 'event',
            id: runId,
            sequence: event.sequence,
          },
        })),
      })),
  );
}
function registerHistory(server: McpServer, engine: Loom): void {
  server.registerTool(
    'loom_history',
    {
      description: 'List durable run summaries in the configured project and agent scope.',
      inputSchema: z.object(page).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset }) => respond(() => engine.history(limit, offset)),
  );
  server.registerTool(
    'loom_conversation',
    {
      description:
        'Read a conversation revision and bounded history preview; use loom_read for full history.',
      inputSchema: z.object({ conversationId: id }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ conversationId }) =>
      respond(() => {
        const row = engine.conversation(conversationId);
        return row
          ? {
              id: row.id,
              revision: row.revision,
              checkpointId: row.checkpointId,
              messageCount: row.history.length,
              recent: row.history
                .slice(-10)
                .map((item) => ({
                  role: item.role,
                  content: preview(item.content, PREVIEW_LENGTH),
                })),
            }
          : null;
      }),
  );
}
function registerTools(server: McpServer, engine: Loom): void {
  server.registerTool(
    'loom_tools',
    {
      description:
        'List configured tool summaries; full input schemas are available through loom_read.',
      inputSchema: z.object(page).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset }) =>
      respond(() => {
        const tools = engine.tools();
        return {
          total: tools.length,
          tools: tools
            .slice(offset, offset + limit)
            .map(({ name, description, definitionHash, readOnly }) => ({
              name,
              description: preview(description, 160),
              definitionHash,
              readOnly,
            })),
        };
      }),
  );
}
function registerRecovery(server: McpServer, engine: Loom): void {
  server.registerTool(
    'loom_tool_status',
    {
      description:
        'Inspect a Hecaton request ID from tool_call events before reconciling an uncertain effect.',
      inputSchema: z.object({ requestId: id }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ requestId }) =>
      respond(() => {
        const row = engine.toolStatus(requestId);
        return row
          ? {
              requestId,
              state: row.call.state,
              active: row.active,
              uncertain: row.uncertain,
              needsReconciliation: row.needsReconciliation,
              result: row.call.result
                ? {
                    success: row.call.result.success,
                    output: preview(row.call.result.output, PREVIEW_LENGTH),
                  }
                : null,
            }
          : null;
      }),
  );
}
function registerReconcile(server: McpServer, engine: Loom): void {
  server.registerTool(
    'loom_reconcile',
    {
      description:
        'Record an independently observed outcome for an uncertain Hecaton effect. Evidence is required.',
      inputSchema: z
        .object({
          requestId: id,
          result: z.record(z.string(), z.unknown()),
          evidence: z.string().min(1).max(8192),
        })
        .strict(),
    },
    async ({ requestId, result, evidence }) =>
      respond(() => {
        const receipt = engine.reconcileTool(requestId, result, evidence);
        return {
          requestId,
          state: receipt.state,
          success: receipt.result.success,
          output: preview(receipt.result.output, PREVIEW_LENGTH),
          experienceId: receipt.experienceId,
        };
      }),
  );
}
