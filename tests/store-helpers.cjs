// Every dialogue storage test owns a fresh temporary directory and all connections closed before cleanup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LoomStore } = require('../dist/store');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-loom-test-'));
  const options = { dbPath: path.join(directory, 'mimir.db'), project: 'project', agent: 'worker' };
  const stores = [],
    cleanup = [];
  const open = (extra = {}) => {
    const store = new LoomStore({ ...options, ...extra });
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const close of cleanup) await close();
    for (const store of stores) store.close();
    const owned = fs.realpathSync.native(directory);
    if (
      path.dirname(owned) !== fs.realpathSync.native(os.tmpdir()) ||
      !path.basename(owned).startsWith('n2-loom-test-')
    )
      throw new Error('Test directory ownership changed');
    fs.rmSync(owned, { recursive: true, force: true });
  });
  return { directory, options, open, cleanup };
}
module.exports = { fixture };
