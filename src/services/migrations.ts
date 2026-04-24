import { Client }   from 'pg';
import * as fs      from 'fs';
import * as path    from 'path';
import type { Instance, MigrationRecord } from '../types';

const MIGRATIONS_TABLE = 'pgmanager_migrations';

function clientFor(instance: Instance, database: string): Client {
  return new Client({
    host:     '127.0.0.1',
    port:     instance.port,
    user:     instance.superuser,
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
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => path.join(dir, f));
}

export async function runMigration(
  instance:  Instance,
  database:  string,
  filePath:  string,
  onLine?:   (line: string) => void,
): Promise<void> {
  const filename = path.basename(filePath);
  const sql      = fs.readFileSync(filePath, 'utf-8');

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
      onLine?.(`✓ Applied ${filename}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}
