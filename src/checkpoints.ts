// Context handoffs retain source-labelled excerpts and immutable links to full model and tool records.
import type { JsonObject } from 'n2-hecaton';
import { objectValue } from './model-validation';
import { column, decode, encode } from './store';
import { fingerprint, utf8Preview } from './values';
import { appendEvent } from './events';
import { DialogueBudgetError } from './budget';
import type { RunStore } from './run-store';
import type { DialogueProgress } from './run-types';
export function snapshot(run: RunStore, kind: 'handoff' | 'final'): JsonObject {
  const row = run.get(),
    progress = row.progress;
  return {
    kind,
    runId: row.request.runId,
    conversationId: row.request.conversationId,
    generation: progress.generation,
    turn: progress.turn,
    request: utf8Preview(row.request.message, 4096),
    output: utf8Preview(progress.output, 8192),
    modifiedFiles: progress.modifiedFiles.slice(-16).map((file) => utf8Preview(file, 512)),
    toolRequestIds: progress.toolRequestIds.slice(-32),
    totalToolReceipts: progress.toolRequestIds.length,
    sourceHash: encode(progress.messages, 2097152).hash,
    failures: progress.failures,
    note: 'Bounded excerpts. Full inputs, outputs and tool receipts are retained in the scoped Loom run records.',
  };
}
export function saveCheckpoint(run: RunStore, value: JsonObject): string {
  const stored = encode(value, 32768),
    id = `loom:${fingerprint({ run: run.lease.runId, kind: value.kind, generation: value.generation, turn: value.turn })}`;
  const previous = run.store.db.query<Record<string, unknown>>(
    `SELECT ${column('snapshot_json', 32768)},${column('snapshot_hash', 64)} FROM loom_checkpoints WHERE project=? AND agent=? AND id=?`,
    [...run.store.scope, id],
  )[0];
  if (previous) {
    if (
      encode(decode(previous.snapshot_json, previous.snapshot_hash, 32768), 32768).hash !==
      stored.hash
    )
      throw new Error('Checkpoint identity already has different contents');
    return id;
  }
  run.charge(Buffer.byteLength(stored.json), value.kind === 'final');
  run.store.db.execute('INSERT INTO loom_checkpoints VALUES(?,?,?,?,?,?,?,?)', [
    ...run.store.scope,
    id,
    run.lease.runId,
    run.get().progress.generation,
    stored.json,
    stored.hash,
    Date.now(),
  ]);
  return id;
}
export function compactContext(run: RunStore): ReturnType<typeof appendEvent> {
  return run.mutate((row) => {
    if (row.progress.phase !== 'model' || row.progress.generation >= run.limits.maxGenerations)
      throw new DialogueBudgetError('Dialogue context generation budget exhausted');
    const saved = snapshot(run, 'handoff'),
      checkpointId = saveCheckpoint(run, saved);
    const budget = Math.floor(run.limits.contextBytes / 8);
    const excerpt = {
      source: 'Loom context handoff',
      checkpointId,
      originalRequest: utf8Preview(row.request.message, budget),
      latestOutput: utf8Preview(row.progress.output, budget),
      completedTools: row.progress.toolRequestIds.slice(-4),
      modifiedFiles: row.progress.modifiedFiles.slice(-4).map((file) => utf8Preview(file, 128)),
      failures: row.progress.failures,
      note: 'These are lossy excerpts of prior context. Use recorded tool evidence to verify the next action.',
    };
    const progress: DialogueProgress = {
      ...row.progress,
      generation: row.progress.generation + 1,
      messages: [{ role: 'user', content: JSON.stringify(excerpt) }],
      lastReply: null,
      nextTool: 0,
    };
    run.saveProgress(progress);
    return appendEvent(
      run,
      'handoff',
      objectValue({
        checkpointId,
        generation: progress.generation,
        originalMessageCount: row.progress.messages.length,
      }),
    );
  });
}
