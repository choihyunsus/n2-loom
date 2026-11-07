// Model generation can retry after interruption while attempts and output reservations remain cumulative.
import { checkedReply } from './model-validation';
import { count } from './record-values';
import { column, decode, encode, hashValue } from './store';
import type { ModelReply } from 'n2-gumiho';
import type { DialogueProgress } from './run-types';
import type { ModelRecord } from './record-types';
import type { RunStore } from './run-store';
import { DialogueBudgetError } from './budget';
export function modelRecord(run: RunStore, turn: number): ModelRecord | undefined {
  count(turn, 'model turn', 128);
  const row = run.store.db.query<Record<string, unknown>>(
    `SELECT ${column('request_hash', 64)},${column('state', 16)},${column('result_json', 524288)},${column('result_hash', 64)},attempts
     FROM loom_models WHERE project=? AND agent=? AND run_id=? AND turn=?`,
    [...run.key(), turn],
  )[0];
  if (!row) return undefined;
  if (!['pending', 'completed'].includes(row.state as string))
    throw new Error('Invalid stored model state');
  const result =
    row.result_json === null && row.result_hash === null
      ? null
      : checkedReply(decode(row.result_json, row.result_hash, 524288) as never);
  if ((row.state === 'completed') !== (result !== null))
    throw new Error('Stored model completion is inconsistent');
  return {
    hash: hashValue(row.request_hash),
    state: row.state as ModelRecord['state'],
    result,
    attempts: count(row.attempts, 'model attempts', 256),
  };
}
export function prepareModel(run: RunStore, turn: number, requestHash: string): ModelRecord {
  hashValue(requestHash);
  return run.mutate((row) => {
    const previous = modelRecord(run, turn);
    if (previous) {
      if (previous.hash !== requestHash)
        throw new Error('A model turn cannot be resumed with changed input');
      return previous;
    }
    if (turn !== row.progress.turn || turn >= run.limits.maxTurns)
      throw new DialogueBudgetError('Dialogue turn budget exhausted or out of order');
    const now = Date.now();
    run.charge(256);
    run.store.db.execute("INSERT INTO loom_models VALUES(?,?,?,?,?,'pending',NULL,NULL,0,?,?)", [
      ...run.key(),
      turn,
      requestHash,
      now,
      now,
    ]);
    return modelRecord(run, turn)!;
  });
}
export function modelAttempt(run: RunStore, turn: number): number {
  return run.mutate((row) => {
    const model = modelRecord(run, turn);
    if (!model || model.state !== 'pending') throw new Error('Model turn is not pending');
    if (
      row.modelRequests >= run.limits.maxModelRequests ||
      row.outputReserved + run.limits.maxOutputTokens > run.limits.maxTotalOutputTokens
    )
      throw new DialogueBudgetError('Dialogue model request or output budget exhausted');
    run.store.db.execute(
      'UPDATE loom_runs SET model_requests=model_requests+1,output_reserved=output_reserved+? WHERE project=? AND agent=? AND id=?',
      [run.limits.maxOutputTokens, ...run.key()],
    );
    run.store.db.execute(
      'UPDATE loom_models SET attempts=attempts+1,updated_at=? WHERE project=? AND agent=? AND run_id=? AND turn=?',
      [Date.now(), ...run.key(), turn],
    );
    return row.modelRequests + 1;
  });
}
export function completeModel(
  run: RunStore,
  turn: number,
  value: ModelReply,
  progress: DialogueProgress,
): void {
  const result = encode(checkedReply(value), 524288);
  run.mutate(() => {
    const row = modelRecord(run, turn);
    if (!row || row.state !== 'pending' || row.attempts < 1)
      throw new Error('Model turn is not awaiting a response');
    run.charge(Buffer.byteLength(result.json));
    run.store.db.execute(
      "UPDATE loom_models SET state='completed',result_json=?,result_hash=?,updated_at=? WHERE project=? AND agent=? AND run_id=? AND turn=?",
      [result.json, result.hash, Date.now(), ...run.key(), turn],
    );
    run.saveProgress(progress);
  });
}
