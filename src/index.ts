#!/usr/bin/env node
// CLI execution uses explicit scope, while inspection opens only existing read-only storage.
import { Loom } from './loom';
import { inspectLoom, type InspectionOptions } from './inspect';
import { inspectHecaton } from 'n2-hecaton';
import {
  parseCli,
  required,
  scopeOptions,
  engineOptions,
  runRequest,
  numberOption,
  HELP,
  type Flags,
} from './cli-options';
import { readJsonFile } from './cli-files';
import { writeOutput, writeText, reportFailure, finishOutput } from './output';
import { serve } from './mcp-serve';
export async function main(args: string[]): Promise<void> {
  const { command, values } = parseCli(args);
  if (command === 'help') {
    await writeText(HELP);
    return;
  }
  if (['status', 'events', 'conversation', 'history', 'tool-status'].includes(command)) {
    await writeOutput(inspect(command, values));
    return;
  }
  const engine = new Loom(await engineOptions(values)),
    controller = new AbortController();
  const stop = () => controller.abort(new Error('CLI execution was cancelled'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await execute(command, values, engine, controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await engine.close();
  }
}
function inspect(command: string, values: Flags): unknown {
  const scope = scopeOptions(values);
  if (command === 'tool-status')
    return inspectHecaton({ ...scope, view: 'status', requestId: required(values, 'request-id') });
  return inspectLoom({
    ...scope,
    view: command as InspectionOptions['view'],
    runId: ['status', 'events'].includes(command) ? required(values, 'run-id') : undefined,
    conversationId: command === 'conversation' ? required(values, 'conversation-id') : undefined,
    limit: numberOption(values, 'limit', 50),
    offset: numberOption(values, 'offset', 0),
    afterSequence: numberOption(values, 'after', 0),
  });
}
async function execute(
  command: string,
  values: Flags,
  engine: Loom,
  signal: AbortSignal,
): Promise<void> {
  if (command === 'mcp') return serve(engine, signal);
  if (command === 'tools') return writeOutput(engine.tools());
  if (command === 'reconcile') {
    const receipt = engine.reconcileTool(
      required(values, 'request-id'),
      readJsonFile(required(values, 'result'), 131072),
      required(values, 'evidence'),
    );
    await writeOutput(receipt);
    return;
  }
  const result = await engine.run(runRequest(values), {
    signal,
    ...(values.stream
      ? { onEvent: (event: unknown) => writeOutput({ type: 'event', event }) }
      : {}),
  });
  await writeOutput(values.stream ? { type: 'result', result } : result);
  if (!result.success) process.exitCode = 1;
}
if (require.main === module) {
  // Write callbacks and the bounded MCP transport own stream failures and cancellation.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  void main(process.argv.slice(2)).catch(reportFailure).finally(finishOutput);
}
