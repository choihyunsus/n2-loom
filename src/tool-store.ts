// Stable Hecaton request IDs reconcile the window between an external effect and its dialogue receipt.
import type { JsonObject, ToolResult } from 'n2-hecaton';
import { objectValue } from './model-validation';
import { count, resultValue } from './record-values';
import { column, decode, encode, hashValue } from './store';
import { fingerprint, identity, preview } from './values';
import { appendEvent } from './events';
import type { ToolRecord } from './record-types';
import type { DialogueProgress, LoomEvent } from './run-types';
import type { RunStore } from './run-store';
import { DialogueBudgetError } from './budget';
export function toolRecord(run: RunStore, turn: number, position: number): ToolRecord | undefined {
  count(turn, 'tool turn', 128);
  count(position, 'tool position', 15);
  const row = run.store.db.query<Record<string, unknown>>(
    `SELECT ${column('request_id', 128)},${column('input_json', 131072)},${column('input_hash', 64)},${column('state', 16)},${column('result_json', 131072)},${column('result_hash', 64)}
     FROM loom_tools WHERE project=? AND agent=? AND run_id=? AND turn=? AND position=?`,
    [...run.key(), turn, position],
  )[0];
  if (!row) return undefined;
  if (!['pending', 'completed'].includes(row.state as string))
    throw new Error('Invalid stored tool state');
  const result =
    row.result_json === null && row.result_hash === null
      ? null
      : resultValue(decode(row.result_json, row.result_hash, 131072));
  if ((row.state === 'completed') !== (result !== null))
    throw new Error('Stored tool completion is inconsistent');
  return {
    requestId: identity(row.request_id, 'tool request ID'),
    input: objectValue(decode(row.input_json, row.input_hash, 131072)),
    hash: hashValue(row.input_hash),
    state: row.state as ToolRecord['state'],
    result,
  };
}
export function prepareTool(
  run: RunStore,
  turn: number,
  position: number,
  input: JsonObject,
): ToolRecord {
  const stored = encode(input, 131072);
  return run.mutate((row) => {
    const previous = toolRecord(run, turn, position);
    if (previous) {
      if (previous.hash !== stored.hash)
        throw new Error('A tool call cannot be resumed with changed arguments');
      return previous;
    }
    if (
      row.progress.phase !== 'tools' ||
      turn !== row.progress.turn ||
      position !== row.progress.nextTool ||
      row.toolCalls >= run.limits.maxToolCalls
    )
      throw new DialogueBudgetError('Dialogue tool budget exhausted or call out of order');
    const id = `loom:${fingerprint({ storage: run.store.storageId, scope: run.store.scope, run: run.lease.runId, turn, position })}`,
      now = Date.now();
    run.charge(Buffer.byteLength(stored.json) + 256);
    run.store.db.execute("INSERT INTO loom_tools VALUES(?,?,?,?,?,?,?,?,'pending',NULL,NULL,?,?)", [
      ...run.key(),
      turn,
      position,
      id,
      stored.json,
      stored.hash,
      now,
      now,
    ]);
    run.store.db.execute(
      'UPDATE loom_runs SET tool_calls=tool_calls+1 WHERE project=? AND agent=? AND id=?',
      run.key(),
    );
    return toolRecord(run, turn, position)!;
  });
}
export function completeTool(
  run: RunStore,
  turn: number,
  position: number,
  value: ToolResult,
  progress: DialogueProgress,
): LoomEvent {
  const result = encode(resultValue(value), 131072);
  return run.mutate(() => {
    const row = toolRecord(run, turn, position);
    if (!row || row.state !== 'pending') throw new Error('Tool call is not awaiting a result');
    run.charge(Buffer.byteLength(result.json), true);
    run.store.db.execute(
      "UPDATE loom_tools SET state='completed',result_json=?,result_hash=?,updated_at=? WHERE project=? AND agent=? AND run_id=? AND turn=? AND position=?",
      [result.json, result.hash, Date.now(), ...run.key(), turn, position],
    );
    run.saveProgress(progress, true);
    return appendEvent(
      run,
      'tool_result',
      {
        turn,
        position,
        requestId: row.requestId,
        success: value.success,
        output: preview(value.output, 1000),
      },
      true,
    );
  });
}
