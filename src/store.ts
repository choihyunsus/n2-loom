// Own a canonical durable database connection while keeping module state separate from shared experiences.
import { MimirDatabase } from 'n2-mimir/storage';
import { databaseFile } from 'n2-hecaton/dist/store';
import { identity as scopeIdentity } from 'n2-hecaton/dist/values';
import { initializeSchema } from './schema';
import { canonicalJson, plainJson, textValue } from './values';
import { createHash } from 'node:crypto';

export type SqlConnection = MimirDatabase['reasoning']['connection'];
export type ReadConnection = Pick<SqlConnection, 'query'>;
export interface ReadStore {
  db: ReadConnection;
  scope: [string, string];
}
export class LoomStore {
  readonly memory: MimirDatabase;
  readonly db: SqlConnection;
  readonly dbPath: string;
  readonly scope: [string, string];
  readonly storageId: string;
  constructor(options: { dbPath: string; project: string; agent: string }) {
    this.scope = [
      scopeIdentity(options.project, 'project', 512),
      scopeIdentity(options.agent, 'agent', 512),
    ];
    this.dbPath = databaseFile(options.dbPath);
    this.memory = new MimirDatabase(this.dbPath);
    this.db = this.memory.reasoning.connection;
    try {
      this.storageId = initializeSchema(this.db);
    } catch (error) {
      this.memory.close();
      throw error;
    }
  }
  close(): void {
    this.memory.close();
  }
}
export function encode(value: unknown, maximum: number): { json: string; hash: string } {
  const json = canonicalJson(value, maximum, 65536);
  return { json, hash: digest(json) };
}
export function decode(value: unknown, hash: unknown, maximum: number) {
  const json = textValue(value, 'stored JSON', maximum);
  if (digest(json) !== hashValue(hash)) throw new Error('Stored dialogue record hash mismatch');
  return plainJson(JSON.parse(json), maximum, 65536, 32);
}
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function hashValue(value: unknown): string {
  const hash = textValue(value, 'record hash', 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid dialogue record hash');
  return hash;
}
export function column(name: string, maximum: number): string {
  if (!/^[a-z_]+$/.test(name) || !Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error('Invalid SQL projection');
  return `CASE WHEN length(CAST(${name} AS BLOB))>${maximum} THEN 0 ELSE ${name} END AS ${name}`;
}
