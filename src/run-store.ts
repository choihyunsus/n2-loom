// Every run mutation checks scope ownership and the reserved conversation revision in one transaction.
import type { JsonObject } from 'n2-hecaton';
import type { ModelMessage } from 'n2-gumiho';
import { checkedReply } from './model-validation';
import { assertRevision, reserveConversation } from './conversations';
import { DialogueLease } from './lease';
import { readRun } from './read-run';
import { count, progressValue, verificationValue } from './record-values';
import { column, encode, type LoomStore } from './store';
import { identity } from './values';
import type { LoomLimits } from './limits';
import type { RunRecord } from './record-types';
import type { CheckedRequest, DialogueProgress, LoomResult } from './run-types';
import { DialogueBudgetError, TRACE_RESERVE } from './budget';

export class RunStore {
  constructor(
    readonly store: LoomStore,
    readonly lease: DialogueLease,
    readonly limits: Readonly<LoomLimits>,
  ) {}
  get(): RunRecord {
    const result = readRun(this.store, this.lease.runId);
    if (!result) throw new Error('Dialogue run does not exist');
    return result;
  }
  mutate<T>(action: (record: RunRecord) => T): T {
    return this.lease.mutate(() => {
      const row = this.get();
      assertRevision(this.store, row.request.conversationId, row.revision);
      if (row.state === 'completed') throw new Error('Completed dialogue is immutable');
      return action(row);
    });
  }
  mutateEvent<T>(
    action: (record: { conversationId: string; eventSequence: number; eventBytes: number }) => T,
  ): T {
    return this.lease.mutate(() => {
      const row = this.store.db.query<Record<string, unknown>>(
        `SELECT ${column('conversation_id', 128)},conversation_revision,${column('state', 16)},event_sequence,event_bytes
         FROM loom_runs WHERE project=? AND agent=? AND id=?`,
        this.key(),
      )[0];
      if (!row || !['running', 'interrupted'].includes(row.state as string))
        throw new Error('Dialogue cannot accept events in its current state');
      const conversationId = identity(row.conversation_id, 'conversation ID');
      const revision = count(row.conversation_revision, 'conversation revision');
      if (!revision) throw new Error('Invalid conversation revision');
      assertRevision(this.store, conversationId, revision);
      return action({
        conversationId,
        eventSequence: count(row.event_sequence, 'event sequence', 65536),
        eventBytes: count(row.event_bytes, 'event bytes', 16777216),
      });
    });
  }
  begin(request: CheckedRequest, config: JsonObject, selectedTools: string[]): RunRecord {
    return this.lease.mutate(() => {
      const old = readRun(this.store, request.runId),
        input = encode(request, 1179648),
        settings = encode(config, 262144);
      if (old) {
        if (
          encode(old.request, 1179648).hash !== input.hash ||
          encode(old.config, 262144).hash !== settings.hash
        )
          throw new Error('A run ID cannot be reused with changed input or configuration');
        if (old.state !== 'completed') {
          assertRevision(this.store, request.conversationId, old.revision);
          this.store.db.execute(
            "UPDATE loom_runs SET state='running',error=NULL,updated_at=? WHERE project=? AND agent=? AND id=?",
            [Date.now(), ...this.key()],
          );
        }
        return this.get();
      }
      const owner = reserveConversation(this.store, request),
        now = Date.now();
      const progress = encode(initialProgress(request, owner.history, selectedTools), 2097152);
      const bytes =
        Buffer.byteLength(input.json) +
        Buffer.byteLength(settings.json) +
        Buffer.byteLength(progress.json);
      if (bytes > this.limits.maxTraceBytes - TRACE_RESERVE)
        throw new DialogueBudgetError('Initial dialogue exceeds trace budget');
      this.store.db.execute(
        `INSERT INTO loom_runs(project,agent,id,conversation_id,conversation_revision,request_json,request_hash,config_json,config_hash,state,progress_json,progress_hash,trace_bytes,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?)`,
        [
          ...this.key(),
          request.conversationId,
          owner.revision,
          input.json,
          input.hash,
          settings.json,
          settings.hash,
          progress.json,
          progress.hash,
          bytes,
          now,
          now,
        ],
      );
      return this.get();
    });
  }
  saveProgress(value: DialogueProgress, terminal = false): void {
    const progress = encode(progressValue(value), 2097152);
    this.mutate((row) => {
      this.charge(
        Math.max(
          0,
          Buffer.byteLength(progress.json) - Buffer.byteLength(encode(row.progress, 2097152).json),
        ),
        terminal,
      );
      this.store.db.execute(
        'UPDATE loom_runs SET progress_json=?,progress_hash=?,updated_at=? WHERE project=? AND agent=? AND id=?',
        [progress.json, progress.hash, Date.now(), ...this.key()],
      );
    });
  }
  saveVerification(value: LoomResult['verification']): void {
    const result = encode(verificationValue(value), 16384);
    this.mutate(() =>
      this.store.db.execute(
        'UPDATE loom_runs SET verification_json=?,verification_hash=?,updated_at=? WHERE project=? AND agent=? AND id=?',
        [result.json, result.hash, Date.now(), ...this.key()],
      ),
    );
  }
  charge(bytes: number, terminal = false): void {
    const row = this.store.db.query<{ trace_bytes: unknown }>(
      'SELECT trace_bytes FROM loom_runs WHERE project=? AND agent=? AND id=?',
      this.key(),
    )[0];
    const traceBytes = count(row?.trace_bytes, 'trace bytes', 67108864);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      traceBytes + bytes > this.limits.maxTraceBytes - (terminal ? 0 : TRACE_RESERVE)
    )
      throw new DialogueBudgetError('Dialogue trace budget exhausted');
    this.store.db.execute(
      'UPDATE loom_runs SET trace_bytes=trace_bytes+? WHERE project=? AND agent=? AND id=?',
      [bytes, ...this.key()],
    );
  }
  interrupt(reason: string): void {
    this.mutate(() =>
      this.store.db.execute(
        "UPDATE loom_runs SET state='interrupted',error=?,updated_at=? WHERE project=? AND agent=? AND id=?",
        [reason, Date.now(), ...this.key()],
      ),
    );
  }
  key(): [string, string, string] {
    return [...this.store.scope, this.lease.runId];
  }
}
function initialProgress(
  request: CheckedRequest,
  history: CheckedRequest['history'],
  selectedTools: string[],
): DialogueProgress {
  const messages: ModelMessage[] = history.map(
    (item): ModelMessage =>
      item.role === 'user'
        ? { role: 'user', content: item.content }
        : {
            role: 'assistant',
            reply: checkedReply({
              text: item.content,
              calls: [],
              stop: 'complete',
              model: 'historical',
              usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null },
            }),
          },
  );
  messages.push({ role: 'user', content: request.message });
  return {
    phase: 'model',
    turn: 0,
    generation: 1,
    messages,
    nextTool: 0,
    lastReply: null,
    output: '',
    modifiedFiles: [],
    toolRequestIds: [],
    failures: 0,
    lastSignature: null,
    selectedTools,
    success: false,
    error: null,
  };
}
