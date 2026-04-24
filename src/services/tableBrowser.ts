import { Client } from 'pg';
import type { Instance, TableInfo, ColumnInfo } from '../types';

function clientFor(instance: Instance, database: string): Client {
  return new Client({
    host:     '127.0.0.1',
    port:     instance.port,
    user:     instance.superuser,
    database,
    connectionTimeoutMillis: 5000,
  });
}

export async function listSchemas(instance: Instance, database: string): Promise<string[]> {
  const client = clientFor(instance, database);
  await client.connect();
  try {
    const res = await client.query<{ schema_name: string }>(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND schema_name NOT LIKE 'pg_temp%'
        AND schema_name NOT LIKE 'pg_toast_temp%'
      ORDER BY schema_name
    `);
    return res.rows.map(r => r.schema_name);
  } finally {
    await client.end();
  }
}

export async function listTables(
  instance: Instance,
  database: string,
  schema:   string,
): Promise<TableInfo[]> {
  const client = clientFor(instance, database);
  await client.connect();
  try {
    const res = await client.query<{
      table_name: string;
      n_live_tup: string;
      size: string;
    }>(`
      SELECT
        t.table_name,
        COALESCE(s.n_live_tup, 0)::text AS n_live_tup,
        pg_size_pretty(pg_total_relation_size(
          quote_ident(t.table_schema) || '.' || quote_ident(t.table_name)
        )) AS size
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s
        ON s.schemaname = t.table_schema AND s.relname = t.table_name
      WHERE t.table_schema = $1
        AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name
    `, [schema]);
    return res.rows.map(r => ({
      schema,
      name:       r.table_name,
      rowEstimate: parseInt(r.n_live_tup, 10),
      sizePretty: r.size,
    }));
  } finally {
    await client.end();
  }
}

export async function describeTable(
  instance: Instance,
  database: string,
  schema:   string,
  table:    string,
): Promise<ColumnInfo[]> {
  const client = clientFor(instance, database);
  await client.connect();
  try {
    const res = await client.query<{
      column_name:    string;
      data_type:      string;
      is_nullable:    string;
      column_default: string | null;
    }>(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schema, table]);
    return res.rows.map(r => ({
      name:         r.column_name,
      dataType:     r.data_type,
      nullable:     r.is_nullable === 'YES',
      defaultValue: r.column_default,
    }));
  } finally {
    await client.end();
  }
}

export async function sampleRows(
  instance: Instance,
  database: string,
  schema:   string,
  table:    string,
  limit:    number = 50,
  offset:   number = 0,
): Promise<Record<string, unknown>[]> {
  const client = clientFor(instance, database);
  await client.connect();
  try {
    const safeTable = `${client.escapeIdentifier(schema)}.${client.escapeIdentifier(table)}`;
    const res = await client.query(`SELECT * FROM ${safeTable} LIMIT $1 OFFSET $2`, [limit, offset]);
    return res.rows;
  } finally {
    await client.end();
  }
}
