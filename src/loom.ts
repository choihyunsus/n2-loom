// The public entry point owns cancellation and releases every database and MCP connection on close.
import { Hecaton } from 'n2-hecaton';
import { configuration, configSnapshot, type RuntimeConfig } from './config';
import { checkedRequest } from './input';
import { LoomStore } from './store';
import { DialogueLease } from './lease';
import { RunStore } from './run-store';
import { DialogueCatalog } from './catalog';
import { EventObserver } from './observer';
import { boundedCallback } from './callback';
import { lifecycle } from './lifecycle';
import { finalizeRun } from './finish';
import { appendEvent, readEvents } from './events';
import { readRun } from './read-run';
import { conversation } from './conversations';
import type { RunRecord } from './record-types';
import { count } from './record-values';
import { runHistory } from './inspect';
import type {
  LoomOptions,
  LoomRequest,
  LoomObserver,
  LoomResult,
  CheckedRequest,
} from './run-types';

export class Loom {
  private readonly config: RuntimeConfig;
  private readonly store: LoomStore;
  private readonly hecaton: Hecaton;
  private readonly policyVersion: string;
  private active?: Promise<LoomResult>;
  private controller?: AbortController;
  private activeRunId?: string;
  private closed = false;
  private closing?: Promise<void>;
  constructor(options: LoomOptions) {
    this.config = configuration(options);
    if (options.tools !== undefined && !Array.isArray(options.tools))
      throw new Error('Tools must be an array');
    this.store = new LoomStore(options);
    try {
      this.hecaton = new Hecaton({
        dbPath: this.store.dbPath,
        project: options.project,
        agent: options.agent,
        tools: options.tools ?? [],
        mcpServers: options.mcpServers,
        policy: options.policy,
      });
      this.policyVersion = options.policy?.version ?? 'registered-tools-1';
    } catch (error) {
      this.store.close();
      throw error;
    }
  }
  run(input: LoomRequest, observer: LoomObserver = {}): Promise<LoomResult> {
    this.assertOpen();
    if (this.active) throw new Error('This Loom instance already has an active dialogue');
    const request = checkedRequest(input, this.config.defaultProvider);
    if (!this.config.providers.has(request.providerId))
      throw new Error('Provider ID is not configured');
    if (!observer || (observer.signal !== undefined && !(observer.signal instanceof AbortSignal)))
      throw new Error('Invalid dialogue observer');
    const ownedObserver = this.checkedObserver(observer, request.runId);
    this.controller = new AbortController();
    this.activeRunId = request.runId;
    const parent = observer.signal
      ? AbortSignal.any([observer.signal, this.controller.signal])
      : this.controller.signal;
    const operation = this.execute(request, ownedObserver, parent);
    this.active = operation;
    void operation
      .finally(() => {
        this.active = undefined;
        this.controller = undefined;
        this.activeRunId = undefined;
      })
      .catch(() => {});
    return operation;
  }
  status(runId: string) {
    this.assertOpen();
    return readRun(this.store, runId);
  }
  private checkedObserver(observer: LoomObserver, runId: string): LoomObserver {
    const afterSequence = count(observer.afterSequence ?? 0, 'event cursor', 65536);
    if (observer.onEvent !== undefined && typeof observer.onEvent !== 'function')
      throw new Error('Invalid event callback');
    if (afterSequence > (readRun(this.store, runId)?.eventSequence ?? 0))
      throw new Error('Event cursor is ahead of the durable stream');
    return { signal: observer.signal, afterSequence, onEvent: observer.onEvent?.bind(observer) };
  }
  conversation(id: string) {
    this.assertOpen();
    return conversation(this.store, id);
  }
  events(runId: string, afterSequence = 0, limit = 100) {
    this.assertOpen();
    return readEvents(this.store, runId, afterSequence, limit);
  }
  tools() {
    this.assertOpen();
    return this.hecaton.list();
  }
  mcpServers() {
    this.assertOpen();
    return this.hecaton.mcpServers();
  }
  history(limit = 50, offset = 0) {
    this.assertOpen();
    return runHistory(this.store, limit, offset);
  }
  toolStatus(requestId: string) {
    this.assertOpen();
    return this.hecaton.status(requestId);
  }
  reconcileTool(requestId: string, result: unknown, evidence: string) {
    this.assertOpen();
    if (this.active) throw new Error('Stop the active dialogue before reconciliation');
    return this.hecaton.reconcile(requestId, result, evidence);
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.dispose();
    return this.closing;
  }
  cancel(runId: string): boolean {
    this.assertOpen();
    if (!this.active || this.activeRunId !== runId) return false;
    this.controller?.abort(new Error('Dialogue was cancelled by its host'));
    return true;
  }
  private async dispose(): Promise<void> {
    this.closed = true;
    this.controller?.abort(new Error('Loom is closing'));
    try {
      await this.active;
    } catch {
      /* The caller retains the interrupted run and its receipts. */
    }
    try {
      await this.hecaton.close();
    } finally {
      this.store.close();
    }
  }
  private async execute(
    request: CheckedRequest,
    observer: LoomObserver,
    parent: AbortSignal,
  ): Promise<LoomResult> {
    parent.throwIfAborted();
    const lease = new DialogueLease(this.store, request.runId),
      run = new RunStore(this.store, lease, this.config.limits);
    let began = false;
    try {
      const catalog = new DialogueCatalog(this.hecaton, this.config.limits.contextBytes);
      const snapshot = configSnapshot(this.config, [...catalog.tools.values()], this.policyVersion);
      const row = run.begin(
        request,
        snapshot,
        request.mode === 'chat' ? [] : catalog.select(request.message),
      );
      began = true;
      return await boundedCallback(
        (signal) => this.continueRun(run, row, catalog, observer, signal),
        this.config.limits.runTimeoutMs,
        AbortSignal.any([parent, lease.controller.signal]),
        'Dialogue',
      );
    } catch (error) {
      if (began) this.interrupt(run, parent.aborted);
      throw error;
    } finally {
      lease.release();
    }
  }
  private async continueRun(
    run: RunStore,
    row: RunRecord,
    catalog: DialogueCatalog,
    observer: LoomObserver,
    signal: AbortSignal,
  ): Promise<LoomResult> {
    const events = new EventObserver(run, observer, signal);
    await events.replay();
    if (row.result) return { ...row.result, cached: true };
    const provider = this.config.providers.get(row.request.providerId)!;
    await events.emit('started', {
      providerId: provider.id,
      model: provider.model,
      textStreaming: provider.textStreaming,
      resumed: row.eventSequence > 0,
    });
    const receipt = await lifecycle({
      run,
      config: this.config,
      catalog,
      hecaton: this.hecaton,
      provider,
      events,
      signal,
    });
    signal.throwIfAborted();
    const finished = finalizeRun(run, receipt);
    for (const event of finished.events) await events.deliver(event);
    return finished.result;
  }
  private interrupt(run: RunStore, cancelled: boolean): void {
    try {
      if (run.get().state === 'completed') return;
      run.mutate(() => {
        run.interrupt(
          cancelled
            ? 'Dialogue was cancelled'
            : 'Dialogue was interrupted; inspect pending receipts before resuming',
        );
        appendEvent(run, cancelled ? 'cancelled' : 'error', { resumable: true }, true);
      });
    } catch {
      /* Ownership loss or storage failure preserves the last committed state. */
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Loom is closed');
  }
}
