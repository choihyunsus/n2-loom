// Persist before delivery, replay by cursor and bound host backpressure independently of provider I/O.
import type { JsonObject } from 'n2-hecaton';
import { boundedCallback, freezeJson } from './callback';
import { appendEvent, readEvents } from './events';
import { count } from './record-values';
import type { EventKind, LoomEvent, LoomObserver } from './run-types';
import type { RunStore } from './run-store';
export class EventObserver {
  private readonly callback?: NonNullable<LoomObserver['onEvent']>;
  private cursor: number;
  constructor(
    readonly run: RunStore,
    observer: LoomObserver,
    private readonly signal: AbortSignal,
  ) {
    this.cursor = count(observer.afterSequence ?? 0, 'event cursor', 65536);
    if (observer.onEvent !== undefined && typeof observer.onEvent !== 'function')
      throw new Error('Invalid event callback');
    this.callback = observer.onEvent?.bind(observer);
  }
  async replay(): Promise<void> {
    if (this.cursor > this.run.get().eventSequence)
      throw new Error('Event cursor is ahead of the durable stream');
    if (!this.callback) return;
    for (;;) {
      const page = readEvents(this.run.store, this.run.lease.runId, this.cursor);
      if (!page.length) return;
      for (const event of page) await this.deliver(event, true);
    }
  }
  async emit(type: EventKind, data: JsonObject): Promise<LoomEvent> {
    this.signal.throwIfAborted();
    const event = appendEvent(this.run, type, data);
    await this.deliver(event);
    return event;
  }
  async deliver(event: LoomEvent, replay = false): Promise<void> {
    this.signal.throwIfAborted();
    if (this.callback) {
      const payload = freezeJson(structuredClone({ ...event, replay }));
      try {
        await boundedCallback(
          () => this.callback!(payload),
          this.run.limits.observerTimeoutMs,
          this.signal,
          'Event observer',
        );
      } catch {
        throw new Error('Event observer failed or exceeded its deadline');
      }
    }
    this.cursor = event.sequence;
  }
}
