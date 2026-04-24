import { Client } from 'pg';
import type { Instance, DatabaseInfo } from '../types';

function clientFor(instance: Instance, database = 'postgres'): Client {
  return new Client({
    host:     '127.0.0.1',
    port:     instance.port,
    user:     instance.superuser,
    database,
    // Trust auth — no password needed for local connections
    connectionTimeoutMillis: 5000,
  });
}

export async function listDatabases(instance: Instance): Promise<DatabaseInfo[]> {
  const client = clientFor(instance);
  await client.connect();
  try {
    const res = await client.query<{
      datname: string;
      owner:   string;
      encoding: string;
      size: string;
    }>(`
      SELECT
        d.datname,
        pg_catalog.pg_get_userbyid(d.datdba) AS owner,
        pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
        pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(d.datname)) AS size
      FROM pg_catalog.pg_database d
      WHERE d.datname NOT IN ('template0', 'template1')
      ORDER BY d.datname
    `);
    return res.rows.map(r => ({
      name:       r.datname,
      owner:      r.owner,
      encoding:   r.encoding,
      sizePretty: r.size,
    }));
  } finally {
    await client.end();
  }
}

export async function createDatabase(instance: Instance, name: string): Promise<void> {
  // CREATE DATABASE cannot run in a transaction, connect to postgres db
  const client = clientFor(instance, 'postgres');
  await client.connect();
  try {
    // pg.escapeIdentifier guards against SQL injection in identifier position
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(instance: Instance, name: string): Promise<void> {
  const client = clientFor(instance, 'postgres');
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)}`);
  } finally {
    await client.end();
  }
}

export function getConnectionString(instance: Instance, database: string): string {
  return `postgresql://${instance.superuser}@127.0.0.1:${instance.port}/${database}`;
}

export async function getActiveConnections(instance: Instance): Promise<number> {
  const client = clientFor(instance);
  await client.connect();
  try {
    const res = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pg_stat_activity WHERE state IS NOT NULL`,
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  } finally {
    await client.end();
  }
}
