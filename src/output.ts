// Apply bounded stdout backpressure so a disconnected consumer cannot retain a running dialogue.
import { preview } from './values';
import { BoundedOutput } from './output-stdio';
export const outputStream = new BoundedOutput();
export async function writeOutput(value: unknown): Promise<void> {
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > 8388608) throw new Error('Output exceeds 8 MiB; use smaller pages');
  await new Promise<void>((resolve, reject) => {
    outputStream.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
export async function finishOutput(): Promise<void> {
  if (!(await outputStream.settle())) return;
  // Native pipe writes can retain an OS worker during normal exit. Main has already closed its work.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 250);
    process.stderr.write('', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  process.kill(process.pid, 'SIGKILL');
}
export function reportFailure(error: unknown): void {
  process.exitCode = 1;
  process.stderr.write(
    JSON.stringify({
      error: preview(error instanceof Error ? error.message : 'Loom operation failed', 1000),
    }) + '\n',
  );
}
