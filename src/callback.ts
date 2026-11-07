// Deadlines settle ignored cancellation and invalidate callback context before a late result can commit.
export async function boundedCallback<T>(
  callback: (signal: AbortSignal) => Promise<T> | T,
  milliseconds: number,
  parent: AbortSignal,
  label: string,
): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController(),
    signal = AbortSignal.any([parent, controller.signal]);
  let timer: NodeJS.Timeout | undefined;
  let abort = () => {};
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error(`${label} was cancelled or exceeded its deadline`));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller.abort(), milliseconds);
      if (signal.aborted) abort();
    });
    const result = await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return callback(signal);
      }),
      cancelled,
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
export function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
