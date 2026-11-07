// Conversation revisions fence interrupted runs while retaining the last meaningful saved dialogue.
import { checkedHistory } from './input';
import { count } from './record-values';
import { column, decode, encode, type LoomStore, type ReadStore } from './store';
import { identity } from './values';
import type { CheckedRequest, HistoryMessage } from './run-types';
export interface Conversation {
  id: string;
  revision: number;
  history: HistoryMessage[];
  checkpointId: string | null;
}
export function conversation(store: ReadStore, id: string): Conversation | undefined {
  identity(id, 'conversation ID');
  const row = store.db.query<Record<string, unknown>>(
    `SELECT revision,${column('history_json', 1048576)},${column('history_hash', 64)},${column('checkpoint_id', 128)}
     FROM loom_conversations WHERE project=? AND agent=? AND id=?`,
    [...store.scope, id],
  )[0];
  if (!row) return undefined;
  const revision = count(row.revision, 'conversation revision');
  if (!revision) throw new Error('Invalid conversation revision');
  return {
    id,
    revision,
    history: checkedHistory(decode(row.history_json, row.history_hash, 1048576)),
    checkpointId: row.checkpoint_id === null ? null : identity(row.checkpoint_id, 'checkpoint ID'),
  };
}
export function reserveConversation(store: LoomStore, request: CheckedRequest): Conversation {
  const previous = conversation(store, request.conversationId);
  if (previous && request.history.length)
    throw new Error('Initial history is only accepted for a new conversation');
  const history = previous?.history ?? request.history;
  const revision = count((previous?.revision ?? 0) + 1, 'conversation revision');
  const stored = encode(history, 1048576),
    now = Date.now();
  store.db.execute(
    `INSERT INTO loom_conversations VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project,agent,id)
     DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`,
    [...store.scope, request.conversationId, revision, stored.json, stored.hash, null, now, now],
  );
  return {
    id: request.conversationId,
    revision,
    history,
    checkpointId: previous?.checkpointId ?? null,
  };
}
export function assertRevision(store: LoomStore, id: string, revision: number): void {
  const current = store.db.query<{ revision: number }>(
    'SELECT revision FROM loom_conversations WHERE project=? AND agent=? AND id=?',
    [...store.scope, id],
  )[0];
  if (current?.revision !== revision)
    throw new Error('This conversation advanced after the interrupted run');
}
