import { Client } from 'pg';
import type { Instance, UserInfo } from '../types';

function clientFor(instance: Instance): Client {
  return new Client({
    host:     instance.host ?? '127.0.0.1',
    port:     instance.port,
    user:     instance.superuser,
    password: instance.password,
    database: 'postgres',
    connectionTimeoutMillis: 5000,
  });
}

export async function listRoles(instance: Instance): Promise<UserInfo[]> {
  const client = clientFor(instance);
  await client.connect();
  try {
    const res = await client.query<{
      rolname: string;
      rolsuper: boolean;
      rolcanlogin: boolean;
      rolreplication: boolean;
      rolconnlimit: number;
    }>(`
      SELECT rolname, rolsuper, rolcanlogin, rolreplication, rolconnlimit
      FROM pg_catalog.pg_roles
      ORDER BY rolname
    `);
    return res.rows.map(r => ({
      name:            r.rolname,
      superuser:       r.rolsuper,
      canLogin:        r.rolcanlogin,
      replication:     r.rolreplication,
      connectionLimit: r.rolconnlimit,
    }));
  } finally {
    await client.end();
  }
}

export interface CreateRoleOptions {
  password?:   string;
  superuser?:  boolean;
  canLogin?:   boolean;
  replication?: boolean;
}

export async function createRole(
  instance: Instance,
  name:     string,
  opts:     CreateRoleOptions = {},
): Promise<void> {
  const client = clientFor(instance);
  await client.connect();
  try {
    const parts: string[] = [];
    if (opts.superuser)  parts.push('SUPERUSER');  else parts.push('NOSUPERUSER');
    if (opts.canLogin)   parts.push('LOGIN');       else parts.push('NOLOGIN');
    if (opts.replication) parts.push('REPLICATION'); else parts.push('NOREPLICATION');

    const escapedName = client.escapeIdentifier(name);

    if (opts.password) {
      // Password is parameterized via the ENCRYPTED PASSWORD clause safely
      await client.query(
        `CREATE ROLE ${escapedName} ${parts.join(' ')} ENCRYPTED PASSWORD $1`,
        [opts.password],
      );
    } else {
      await client.query(`CREATE ROLE ${escapedName} ${parts.join(' ')}`);
    }
  } finally {
    await client.end();
  }
}

export async function dropRole(instance: Instance, name: string): Promise<void> {
  const client = clientFor(instance);
  await client.connect();
  try {
    await client.query(`DROP ROLE IF EXISTS ${client.escapeIdentifier(name)}`);
  } finally {
    await client.end();
  }
}

export async function grantDatabase(
  instance: Instance,
  role:     string,
  database: string,
): Promise<void> {
  const client = clientFor(instance);
  await client.connect();
  try {
    await client.query(
      `GRANT ALL PRIVILEGES ON DATABASE ${client.escapeIdentifier(database)} TO ${client.escapeIdentifier(role)}`,
    );
  } finally {
    await client.end();
  }
}

export async function changeRolePassword(
  instance: Instance,
  roleName: string,
  newPassword: string,
): Promise<void> {
  const client = clientFor(instance);
  await client.connect();
  try {
    // Password is fully parameterized — never interpolated into the query string
    await client.query(
      `ALTER ROLE ${client.escapeIdentifier(roleName)} WITH ENCRYPTED PASSWORD $1`,
      [newPassword],
    );
  } finally {
    await client.end();
  }
}
