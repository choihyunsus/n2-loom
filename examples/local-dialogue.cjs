// Stream one local dialogue and retain its scoped history in a configurable SQLite file.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Loom } = require('../dist/library');
const host = require('./host.cjs');
async function main() {
  const engine = new Loom({
    ...host,
    dbPath: process.env.N2_LOOM_DB ?? path.resolve('data/mimir.db'),
    project: 'demo',
    agent: 'assistant',
  });
  try {
    const result = await engine.run(
      {
        runId: randomUUID(),
        conversationId: 'local-demo',
        message:
          process.argv.slice(2).join(' ') ||
          'Use word_count to count the words in "hello local agent".',
      },
      {
        onEvent(event) {
          if (event.type === 'delta') process.stdout.write(event.data.text);
        },
      },
    );
    process.stdout.write(
      '\n' +
        JSON.stringify({
          success: result.success,
          error: result.error,
          runId: result.runId,
          experienceId: result.experienceId,
        }) +
        '\n',
    );
    if (!result.success) process.exitCode = 1;
  } finally {
    await engine.close();
  }
}
void main().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
