// Inspect existing dialogue records without loading providers, host code or schema migrations.
import Database from 'better-sqlite3';
import { databaseFile } from 'n2-hecaton/dist/store';
import { identity as scopeIdentity } from 'n2-hecaton/dist/values';
import { column, type ReadStore } from './store';
import { readRun } from './read-run';
import { readEvents } from './events';
import { conversation } from './conversations';
import { count } from './record-values';
import { identity, textValue } from './values';
export interface InspectionOptions {
  dbPath: string;
  project: string;
  agent: string;
  view: 'status' | 'events' | 'conversation' | 'history';
  runId?: string;
  conversationId?: string;
  afterSequence?: number;
  limit?: number;
  offset?: number;
}
export function inspectLoom(options: InspectionOptions) {
  const scope: [string, string] = [
    scopeIdentity(options.project, 'project', 512),
    scopeIdentity(options.agent, 'agent', 512),
  ];
  const db = new Database(databaseFile(options.dbPath, false), {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });
  try {
    db.pragma('query_only=ON');
    const store: ReadStore = {
      scope,
      db: {
        query<T>(sql: string, values: readonly (string | number | null)[] = []) {
          return db.prepare(sql).all(...values) as T[];
        },
      },
    };
    const version = store.db.query<{ value: string }>(
      `SELECT ${column('value', 16)} FROM meta WHERE key='loom_schema_version'`,
    )[0]?.value;
    if (version !== '1') throw new Error('An initialized Loom schema version 1 is required');
    return inspectView(store, options);
  } finally {
    db.close();
  }
}
function inspectView(store: ReadStore, options: InspectionOptions) {
  if (options.view === 'status')
    return {
      view: 'status' as const,
      status: readRun(store, identity(options.runId, 'run ID')) ?? null,
    };
  if (options.view === 'events')
    return {
      view: 'events' as const,
      events: readEvents(
        store,
        identity(options.runId, 'run ID'),
        options.afterSequence,
        options.limit,
      ),
    };
  if (options.view === 'conversation')
    return {
      view: 'conversation' as const,
      conversation:
        conversation(store, identity(options.conversationId, 'conversation ID')) ?? null,
    };
  if (options.view === 'history')
    return { view: 'history' as const, history: runHistory(store, options.limit, options.offset) };
  throw new Error('Unknown dialogue inspection view');
}
export function runHistory(store: ReadStore, limit = 50, offset = 0) {
  if (!count(limit, 'history page size', 100))
    throw new Error('History page size must be positive');
  count(offset, 'history offset', 1000000);
  return store.db
    .query<Record<string, unknown>>(
      `SELECT ${column('id', 128)},${column('conversation_id', 128)},${column('state', 16)},model_requests,tool_calls,created_at,updated_at
     FROM loom_runs WHERE project=? AND agent=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
      [...store.scope, limit, offset],
    )
    .map((row) => {
      const state = textValue(row.state, 'run state', 16);
      if (!['running', 'interrupted', 'completed'].includes(state))
        throw new Error('Invalid stored run state');
      return {
        runId: identity(row.id, 'run ID'),
        conversationId: identity(row.conversation_id, 'conversation ID'),
        state,
        modelRequests: count(row.model_requests, 'model requests', 256),
        toolCalls: count(row.tool_calls, 'tool calls', 512),
        createdAt: count(row.created_at, 'creation time'),
        updatedAt: count(row.updated_at, 'update time'),
      };
    });
}
