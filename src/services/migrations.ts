import { Client }   from 'pg';
import * as fs      from 'fs';
import * as path    from 'path';
import type { Instance, MigrationRecord } from '../types';
import * as audit from './auditLog';

const MIGRATIONS_TABLE = 'pgmanager_migrations';

function clientFor(instance: Instance, database: string): Client {
  return new Client({
    host:     instance.host ?? '127.0.0.1',
    port:     instance.port,
    user:     instance.superuser,
    password: instance.password,
    database,
    connectionTimeoutMillis: 5000,
  });
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getAppliedMigrations(
  instance: Instance,
  database: string,
): Promise<MigrationRecord[]> {
  const client = clientFor(instance, database);
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const res = await client.query<{ filename: string; applied_at: string }>(
      `SELECT filename, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY filename`,
    );
    return res.rows.map(r => ({ filename: r.filename, appliedAt: r.applied_at }));
  } finally {
    await client.end();
  }
}

export function discoverMigrationFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const resolvedDir = path.resolve(dir);
  return fs
    .readdirSync(resolvedDir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => path.join(resolvedDir, f))
    // Path-traversal guard: readdirSync never returns '..' entries, but we
    // still verify each resolved path is inside the intended directory in
    // case of future refactors or symlinked entries.
    .filter(full => path.resolve(full).startsWith(resolvedDir + path.sep));
}

export async function runMigration(
  instance:  Instance,
  database:  string,
  filePath:  string,
  onLine?:   (line: string) => void,
): Promise<void> {
  const resolved = path.resolve(filePath);
  const filename = path.basename(resolved);
  // Defense-in-depth: require that the file actually exists on disk and is a
  // regular file. Rejects piping, device files, etc.
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Migration path is not a regular file: ${resolved}`);
  }
  const sql      = fs.readFileSync(resolved, 'utf-8');

  const client = clientFor(instance, database);
  await client.connect();
  try {
    await ensureMigrationsTable(client);

    // Check it hasn't already been applied
    const existing = await client.query(
      `SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE filename = $1`,
      [filename],
    );
    if ((existing.rowCount ?? 0) > 0) {
      onLine?.(`Skipping ${filename} (already applied)`);
      return;
    }

    onLine?.(`Running ${filename}...`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`,
        [filename],
      );
      await client.query('COMMIT');
      audit.record({ category: 'migration', action: 'apply', instanceId: instance.id, database, target: filename, ok: true });
      onLine?.(`✓ Applied ${filename}`);
    } catch (err: any) {
      await client.query('ROLLBACK');
      audit.record({ category: 'migration', action: 'apply', instanceId: instance.id, database, target: filename, ok: false, error: err?.message ?? String(err) });
      throw err;
    }
  } finally {
    await client.end();
  }
}
