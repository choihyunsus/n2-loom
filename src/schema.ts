// Store scoped dialogue state beside the common Soul schema and require explicit legacy migration.
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from './store';

export function initializeSchema(db: SqlConnection): string {
  return db.transaction(() => {
    const version = db.query<{ value: unknown }>(
      "SELECT CASE WHEN length(CAST(value AS BLOB))<=16 THEN value END AS value FROM meta WHERE key='loom_schema_version'",
    )[0]?.value;
    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'loom_*' LIMIT 8",
    );
    if (version !== undefined && version !== '1')
      throw new Error('Unsupported Loom schema version');
    if (version === undefined && tables.length)
      throw new Error('Unversioned Loom tables require explicit migration');
    if (version !== undefined && tables.length !== Object.keys(COLUMNS).length)
      throw new Error('Loom schema is incomplete');
    for (const table of tables) {
      const columns = db.query<{ name: string; pk: number }>(
        'SELECT name,pk FROM pragma_table_info(?)',
        [table.name],
      );
      if (COLUMNS[table.name]?.join(',') !== columns.map((column) => column.name).join(','))
        throw new Error('Existing Loom table has an incompatible schema');
      if (
        columns.some(
          (column, index) => column.pk !== (index < PRIMARY_KEYS[table.name]! ? index + 1 : 0),
        )
      )
        throw new Error('Existing Loom table has an incompatible primary key schema');
    }
    for (const statement of STATEMENTS) db.execute(statement);
    db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('loom_schema_version','1')");
    db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('loom_storage_id',?)", [randomUUID()]);
    const id = db.query<{ value: unknown }>(
      "SELECT CASE WHEN length(CAST(value AS BLOB))<=36 THEN value END AS value FROM meta WHERE key='loom_storage_id'",
    )[0]?.value;
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
    )
      throw new Error('Invalid Loom storage ID');
    return id;
  });
}
const PRIMARY_KEYS: Record<string, number> = {
  loom_conversations: 3,
  loom_runs: 3,
  loom_models: 4,
  loom_tools: 5,
  loom_events: 4,
  loom_checkpoints: 3,
  loom_leases: 2,
};
const COLUMNS: Record<string, string[]> = {
  loom_conversations: [
    'project',
    'agent',
    'id',
    'revision',
    'history_json',
    'history_hash',
    'checkpoint_id',
    'created_at',
    'updated_at',
  ],
  loom_runs: [
    'project',
    'agent',
    'id',
    'conversation_id',
    'conversation_revision',
    'request_json',
    'request_hash',
    'config_json',
    'config_hash',
    'state',
    'progress_json',
    'progress_hash',
    'verification_json',
    'verification_hash',
    'result_json',
    'result_hash',
    'experience_id',
    'checkpoint_id',
    'model_requests',
    'tool_calls',
    'output_reserved',
    'event_sequence',
    'event_bytes',
    'trace_bytes',
    'error',
    'created_at',
    'updated_at',
  ],
  loom_models: [
    'project',
    'agent',
    'run_id',
    'turn',
    'request_hash',
    'state',
    'result_json',
    'result_hash',
    'attempts',
    'created_at',
    'updated_at',
  ],
  loom_tools: [
    'project',
    'agent',
    'run_id',
    'turn',
    'position',
    'request_id',
    'input_json',
    'input_hash',
    'state',
    'result_json',
    'result_hash',
    'created_at',
    'updated_at',
  ],
  loom_events: ['project', 'agent', 'run_id', 'sequence', 'event_json', 'event_hash', 'created_at'],
  loom_checkpoints: [
    'project',
    'agent',
    'id',
    'run_id',
    'generation',
    'snapshot_json',
    'snapshot_hash',
    'created_at',
  ],
  loom_leases: ['project', 'agent', 'run_id', 'nonce', 'process_id', 'expires_at'],
};
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS loom_conversations (
    project TEXT NOT NULL, agent TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
    history_json TEXT NOT NULL CHECK(length(CAST(history_json AS BLOB))<=1048576), history_hash TEXT NOT NULL,
    checkpoint_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(project,agent,id))`,
  `CREATE TABLE IF NOT EXISTS loom_runs (
    project TEXT NOT NULL, agent TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    conversation_revision INTEGER NOT NULL CHECK(conversation_revision>0),
    request_json TEXT NOT NULL CHECK(length(CAST(request_json AS BLOB))<=1179648), request_hash TEXT NOT NULL,
    config_json TEXT NOT NULL CHECK(length(CAST(config_json AS BLOB))<=262144), config_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('running','interrupted','completed')),
    progress_json TEXT NOT NULL CHECK(length(CAST(progress_json AS BLOB))<=2097152), progress_hash TEXT NOT NULL,
    verification_json TEXT CHECK(length(CAST(verification_json AS BLOB))<=16384), verification_hash TEXT,
    result_json TEXT CHECK(length(CAST(result_json AS BLOB))<=524288), result_hash TEXT,
    experience_id TEXT, checkpoint_id TEXT, model_requests INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0, output_reserved INTEGER NOT NULL DEFAULT 0,
    event_sequence INTEGER NOT NULL DEFAULT 0, event_bytes INTEGER NOT NULL DEFAULT 0,
    trace_bytes INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(project,agent,id), FOREIGN KEY(project,agent,conversation_id) REFERENCES loom_conversations(project,agent,id))`,
  `CREATE INDEX IF NOT EXISTS idx_loom_runs_history ON loom_runs(project,agent,conversation_id,created_at DESC,id)`,
  `CREATE TABLE IF NOT EXISTS loom_models (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL, turn INTEGER NOT NULL,
    request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('pending','completed')),
    result_json TEXT CHECK(length(CAST(result_json AS BLOB))<=524288), result_hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(project,agent,run_id,turn), FOREIGN KEY(project,agent,run_id) REFERENCES loom_runs(project,agent,id))`,
  `CREATE TABLE IF NOT EXISTS loom_tools (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL, turn INTEGER NOT NULL, position INTEGER NOT NULL,
    request_id TEXT NOT NULL, input_json TEXT NOT NULL CHECK(length(CAST(input_json AS BLOB))<=131072), input_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('pending','completed')),
    result_json TEXT CHECK(length(CAST(result_json AS BLOB))<=131072), result_hash TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(project,agent,run_id,turn,position), UNIQUE(project,agent,request_id),
    FOREIGN KEY(project,agent,run_id) REFERENCES loom_runs(project,agent,id))`,
  `CREATE TABLE IF NOT EXISTS loom_events (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    event_json TEXT NOT NULL CHECK(length(CAST(event_json AS BLOB))<=262144), event_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(project,agent,run_id,sequence),
    FOREIGN KEY(project,agent,run_id) REFERENCES loom_runs(project,agent,id))`,
  `CREATE TABLE IF NOT EXISTS loom_checkpoints (
    project TEXT NOT NULL, agent TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL, generation INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL CHECK(length(CAST(snapshot_json AS BLOB))<=32768), snapshot_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(project,agent,id),
    FOREIGN KEY(project,agent,run_id) REFERENCES loom_runs(project,agent,id))`,
  `CREATE TABLE IF NOT EXISTS loom_leases (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL, nonce TEXT NOT NULL,
    process_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(project,agent))`,
];
