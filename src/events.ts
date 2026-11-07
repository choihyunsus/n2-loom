// Durable sequence numbers support replay without treating an already committed event as a new effect.
import type { JsonObject } from 'n2-hecaton';
import { objectValue } from './model-validation';
import { count } from './record-values';
import { column, decode, encode, type ReadStore } from './store';
import { identity } from './values';
import type { EventKind, LoomEvent } from './run-types';
import type { RunStore } from './run-store';
import { DialogueBudgetError } from './budget';
const KINDS: EventKind[] = [
  'started',
  'delta',
  'tool_call',
  'tool_confirm',
  'tool_start',
  'tool_result',
  'handoff',
  'verified',
  'done',
  'error',
  'cancelled',
];
const MAX_EVENT_SEQUENCE = 65536;
export function appendEvent(
  run: RunStore,
  type: EventKind,
  data: JsonObject,
  terminal = false,
): LoomEvent {
  return run.mutateEvent((row) => {
    if (!KINDS.includes(type)) throw new Error('Unknown dialogue event');
    const event: LoomEvent = {
      runId: run.lease.runId,
      conversationId: row.conversationId,
      sequence: row.eventSequence + 1,
      type,
      data,
      createdAt: Date.now(),
    };
    const stored = encode(event, 262144),
      bytes = Buffer.byteLength(stored.json);
    if (
      event.sequence > run.limits.maxEvents - (terminal ? 0 : 4) ||
      row.eventBytes + bytes > run.limits.maxEventBytes - (terminal ? 0 : 65536)
    )
      throw new DialogueBudgetError('Dialogue event budget exhausted');
    run.charge(bytes, terminal);
    run.store.db.execute('INSERT INTO loom_events VALUES(?,?,?,?,?,?,?)', [
      ...run.key(),
      event.sequence,
      stored.json,
      stored.hash,
      event.createdAt,
    ]);
    run.store.db.execute(
      'UPDATE loom_runs SET event_sequence=?,event_bytes=event_bytes+? WHERE project=? AND agent=? AND id=?',
      [event.sequence, bytes, ...run.key()],
    );
    return event;
  });
}
export function readEvents(
  store: ReadStore,
  runId: string,
  afterSequence = 0,
  limit = 100,
): LoomEvent[] {
  identity(runId, 'run ID');
  count(afterSequence, 'event cursor', MAX_EVENT_SEQUENCE);
  if (!count(limit, 'event page size', 100)) throw new Error('Event page size must be positive');
  return store.db
    .query<Record<string, unknown>>(
      `SELECT sequence,${column('event_json', 262144)},${column('event_hash', 64)} FROM loom_events
     WHERE project=? AND agent=? AND run_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
      [...store.scope, runId, afterSequence, limit],
    )
    .map((row) => {
      const event = objectValue(decode(row.event_json, row.event_hash, 262144));
      if (
        event.runId !== runId ||
        event.sequence !== row.sequence ||
        !KINDS.includes(event.type as EventKind)
      )
        throw new Error('Invalid stored event identity');
      return {
        runId,
        conversationId: identity(event.conversationId, 'conversation ID'),
        sequence: count(event.sequence, 'event sequence', MAX_EVENT_SEQUENCE),
        type: event.type as EventKind,
        data: objectValue(event.data),
        createdAt: count(event.createdAt, 'event creation time'),
      };
    });
}
