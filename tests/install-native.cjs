// Install the verified platform build only into the test consumer's resolved Mimir dependency.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const input = fs.realpathSync.native(process.argv[2]);
const filename =
  process.platform === 'win32'
    ? 'n2_mimir_core.dll'
    : process.platform === 'darwin'
      ? 'libn2_mimir_core.dylib'
      : 'libn2_mimir_core.so';
const source = fs.statSync(input).isDirectory()
  ? path.join(
      input,
      fs.existsSync(path.join(input, 'n2-mimir-core.node')) ? 'n2-mimir-core.node' : filename,
    )
  : input;
const info = fs.statSync(source);
if (!info.isFile() || info.size < 1 || info.size > 67108864)
  throw new Error('Invalid native test artifact');
const target = path.join(path.dirname(require.resolve('n2-mimir/storage')), 'n2-mimir-core.node');
fs.copyFileSync(source, target);
process.stdout.write(
  JSON.stringify({
    bytes: info.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
  }) + '\n',
);
