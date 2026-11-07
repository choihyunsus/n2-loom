// Explicit host modules execute local code; request and limits files are bounded UTF-8 JSON data.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { identity } from 'n2-hecaton/dist/values';
import { plainJson } from './values';
import type { LoomOptions } from './run-types';
export type HostOptions = Omit<LoomOptions, 'dbPath' | 'project' | 'agent'>;
function regularFile(filename: string, maximum: number): string {
  const input = identity(filename, 'local filename', 8192);
  if (/^\\\\[.?]\\/u.test(input)) throw new Error('A regular local file is required');
  const resolved = path.resolve(input);
  if (
    process.platform === 'win32' &&
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)|:/i.test(path.basename(resolved))
  )
    throw new Error('Local file uses a reserved device or stream name');
  const canonical = fs.realpathSync.native(resolved),
    info = fs.statSync(canonical);
  if (!info.isFile() || info.size > maximum)
    throw new Error('Local file exceeds its type or size limit');
  return canonical;
}
export function readJsonFile(filename: string, maximum = 1179648) {
  const resolved = regularFile(filename, maximum);
  const handle = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = fs.fstatSync(handle);
    if (!info.isFile() || info.size > maximum) throw new Error('Expected a bounded regular file');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(handle, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maximum) throw new Error('JSON file grew beyond its size limit');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    return plainJson(JSON.parse(text), maximum, 65536, 32);
  } finally {
    fs.closeSync(handle);
  }
}
export async function hostOptions(filename: string): Promise<Partial<HostOptions>> {
  const resolved = regularFile(filename, 1048576);
  if (!['.js', '.cjs', '.mjs'].includes(path.extname(resolved)))
    throw new Error('Host must be a local JavaScript module');
  try {
    const loaded = await import(pathToFileURL(resolved).href),
      host = loaded.default ?? loaded;
    if (!host || typeof host !== 'object' || Array.isArray(host)) throw new Error('Invalid host');
    return {
      provider: host.provider,
      providers: host.providers,
      tools: host.tools,
      mcpServers: host.mcpServers,
      policy: host.policy,
      preparation: host.preparation,
      verifier: host.verifier,
      confirmation: host.confirmation,
      limits: host.limits,
    };
  } catch {
    throw new Error('Host module could not be loaded');
  }
}
