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

// ─── Extended detail ─────────────────────────────────────────────────────────

export interface DatabaseDetail {
  name:            string;
  owner:           string;
  encoding:        string;
  collation:       string;
  ctypeLocale:     string;
  tablespace:      string;
  sizePretty:      string;
  connectionLimit: number;   // -1 = unlimited
  activeConnections: number;
  allowConnections: boolean;
  isTemplate:      boolean;
}

export async function getDatabaseDetail(
  instance: Instance,
  dbName:   string,
): Promise<DatabaseDetail> {
  const client = clientFor(instance);
  await client.connect();
  try {
    const res = await client.query<{
      datname: string;
      owner: string;
      encoding: string;
      collation: string;
      ctype: string;
      spcname: string;
      size: string;
      datconnlimit: number;
      active: string;
      datallowconn: boolean;
      datistemplate: boolean;
    }>(`
      SELECT
        d.datname,
        pg_catalog.pg_get_userbyid(d.datdba)            AS owner,
        pg_catalog.pg_encoding_to_char(d.encoding)      AS encoding,
        d.datcollate                                     AS collation,
        d.datctype                                       AS ctype,
        t.spcname,
        pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(d.datname)) AS size,
        d.datconnlimit,
        (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = d.datname) AS active,
        d.datallowconn,
        d.datistemplate
      FROM pg_catalog.pg_database d
      JOIN pg_catalog.pg_tablespace t ON t.oid = d.dattablespace
      WHERE d.datname = $1
    `, [dbName]);

    const r = res.rows[0];
    if (!r) throw new Error(`Database "${dbName}" not found`);

    return {
      name:             r.datname,
      owner:            r.owner,
      encoding:         r.encoding,
      collation:        r.collation,
      ctypeLocale:      r.ctype,
      tablespace:       r.spcname,
      sizePretty:       r.size,
      connectionLimit:  r.datconnlimit,
      activeConnections: parseInt(String(r.active), 10),
      allowConnections: r.datallowconn,
      isTemplate:       r.datistemplate,
    };
  } finally {
    await client.end();
  }
}

export async function renameDatabase(
  instance: Instance,
  oldName:  string,
  newName:  string,
): Promise<void> {
  // Terminate existing connections before rename
  const client = clientFor(instance);
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [oldName],
    );
    await client.query(
      `ALTER DATABASE ${client.escapeIdentifier(oldName)} RENAME TO ${client.escapeIdentifier(newName)}`,
    );
  } finally {
    await client.end();
  }
}

export async function changeOwner(
  instance: Instance,
  dbName:   string,
  newOwner: string,
): Promise<void> {
  const client = clientFor(instance);
  await client.connect();
  try {
    await client.query(
      `ALTER DATABASE ${client.escapeIdentifier(dbName)} OWNER TO ${client.escapeIdentifier(newOwner)}`,
    );
  } finally {
    await client.end();
  }
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
