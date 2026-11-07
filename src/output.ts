// Apply bounded stdout backpressure so a disconnected consumer cannot retain a running dialogue.
import { preview } from './values';
import { writeText as writeBoundedText } from 'n2-hecaton/dist/output';
export { outputStream, finishOutput } from 'n2-hecaton/dist/output';
export async function writeOutput(value: unknown): Promise<void> {
  return writeText(JSON.stringify(value) + '\n');
}
export async function writeText(text: string): Promise<void> {
  if (Buffer.byteLength(text) > 8388608) throw new Error('Output exceeds 8 MiB; use smaller pages');
  await writeBoundedText(text);
}
export function reportFailure(error: unknown): void {
  process.exitCode = 1;
  process.stderr.write(
    JSON.stringify({
      error: preview(error instanceof Error ? error.message : 'Loom operation failed', 1000),
    }) + '\n',
  );
}
