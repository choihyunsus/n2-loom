// One project/agent dialogue owns its writes; nonces fence late callbacks and restarted processes.
import { randomUUID } from 'node:crypto';
import { identity } from './values';
import { column, type LoomStore } from './store';
const LEASE_MS = 30000;
export class DialogueLease {
  readonly nonce = randomUUID();
  readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private checked = 0;
  private released = false;
  constructor(
    private readonly store: LoomStore,
    readonly runId: string,
  ) {
    identity(runId, 'run ID');
    store.db.transaction(() => {
      const row = this.row();
      if (row && row.expires_at > Date.now() && alive(row.process_id))
        throw new Error('This project and agent already have an active Loom dialogue');
      store.db.execute(
        `INSERT INTO loom_leases VALUES(?,?,?,?,?,?) ON CONFLICT(project,agent)
        DO UPDATE SET run_id=excluded.run_id,nonce=excluded.nonce,process_id=excluded.process_id,expires_at=excluded.expires_at`,
        [...store.scope, runId, this.nonce, process.pid, Date.now() + LEASE_MS],
      );
    });
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  assert(): void {
    this.controller.signal.throwIfAborted();
    const row = this.row();
    if (
      !row ||
      row.nonce !== this.nonce ||
      row.run_id !== this.runId ||
      row.expires_at <= Date.now()
    )
      throw new Error('Loom dialogue ownership was lost or expired');
  }
  mutate<T>(action: () => T): T {
    return this.store.db.transaction(() => {
      this.assert();
      return action();
    });
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    clearInterval(this.timer);
    this.controller.abort(new Error('Loom dialogue ownership ended'));
    this.store.db.execute('DELETE FROM loom_leases WHERE project=? AND agent=? AND nonce=?', [
      ...this.store.scope,
      this.nonce,
    ]);
  }
  private row():
    | { run_id: string; nonce: string; process_id: number; expires_at: number }
    | undefined {
    const row = this.store.db.query<{
      run_id: string;
      nonce: string;
      process_id: number;
      expires_at: number;
    }>(
      `SELECT ${column('run_id', 128)},${column('nonce', 36)},process_id,expires_at FROM loom_leases WHERE project=? AND agent=?`,
      this.store.scope,
    )[0];
    if (
      row &&
      (!Number.isSafeInteger(row.process_id) ||
        row.process_id < 1 ||
        row.process_id > 2147483647 ||
        !Number.isSafeInteger(row.expires_at) ||
        row.expires_at < 0 ||
        typeof row.nonce !== 'string' ||
        row.nonce.length !== 36)
    )
      throw new Error('Stored dialogue ownership is invalid');
    if (row) identity(row.run_id, 'stored owner run ID');
    return row;
  }
  private tick(): void {
    try {
      this.mutate(() => {
        if (++this.checked % 10 === 0)
          this.store.db.execute(
            'UPDATE loom_leases SET expires_at=? WHERE project=? AND agent=? AND nonce=?',
            [Date.now() + LEASE_MS, ...this.store.scope, this.nonce],
          );
      });
    } catch {
      clearInterval(this.timer);
      this.controller.abort(new Error('Loom dialogue ownership was lost'));
    }
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
