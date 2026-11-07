// Each subprocess uses a fresh fixture host, explicit scope and hidden windows on Windows.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fixture } = require('./store-helpers.cjs');
const entry = path.resolve(__dirname, '../dist/index.js');
const execute = promisify(execFile);
function cliSetup(t, hostSource) {
  const data = fixture(t);
  const host = path.join(data.directory, 'host.cjs');
  fs.writeFileSync(
    host,
    hostSource ??
      `module.exports = { provider: {
    id: 'fixture', version: '1', model: 'fixture', local: true,
    async generate(request) { return { text: 'Hello😀', calls: [], stop: 'complete', model: 'fixture', usage: {inputTokens:1,outputTokens:2,cachedInputTokens:0} }; }
  } };`,
  );
  const scope = [
    '--db',
    data.options.dbPath,
    '--project',
    data.options.project,
    '--agent',
    data.options.agent,
  ];
  const run = async (command, args = []) => {
    try {
      return {
        code: 0,
        ...(await execute(process.execPath, [entry, command, ...scope, ...args], {
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 8388608,
        })),
      };
    } catch (error) {
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  };
  return { ...data, host, scope, entry, run };
}
module.exports = { cliSetup, entry };
