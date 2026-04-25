import { Client } from 'pg';
import type { Instance, UserInfo } from '../types';
import * as audit from './auditLog';

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

    // CREATE ROLE doesn't support $1 parameters in PostgreSQL DDL.
    // Create the role first, then set the password via ALTER ROLE which does support params.
    await client.query(`CREATE ROLE ${escapedName} ${parts.join(' ')}`);
    if (opts.password) {
      await client.query(
        `ALTER ROLE ${escapedName} WITH ENCRYPTED PASSWORD $1`,
        [opts.password],
      );
    }
    audit.record({ category: 'user', action: 'create', instanceId: instance.id, target: name, ok: true,
      meta: { superuser: !!opts.superuser, canLogin: !!opts.canLogin, hasPassword: !!opts.password } });
  } catch (err: any) {
    audit.record({ category: 'user', action: 'create', instanceId: instance.id, target: name, ok: false, error: err?.message ?? String(err) });
    throw err;
  } finally {
    await client.end();
  }
}

export async function dropRole(instance: Instance, name: string): Promise<void> {
  const client = clientFor(instance);
  await client.connect();
  try {
    await client.query(`DROP ROLE IF EXISTS ${client.escapeIdentifier(name)}`);
    audit.record({ category: 'user', action: 'drop', instanceId: instance.id, target: name, ok: true });
  } catch (err: any) {
    audit.record({ category: 'user', action: 'drop', instanceId: instance.id, target: name, ok: false, error: err?.message ?? String(err) });
    throw err;
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
    audit.record({ category: 'user', action: 'grant', instanceId: instance.id, database, target: role, ok: true });
  } catch (err: any) {
    audit.record({ category: 'user', action: 'grant', instanceId: instance.id, database, target: role, ok: false, error: err?.message ?? String(err) });
    throw err;
  } finally {
    await client.end();
  }
}

export interface AlterRoleOptions {
  superuser?:   boolean;
  canLogin?:    boolean;
  replication?: boolean;
}

export async function alterRole(
  instance: Instance,
  name:     string,
  opts:     AlterRoleOptions,
): Promise<void> {
  const client = clientFor(instance);
  await client.connect();
  try {
    const parts: string[] = [];
    if (opts.superuser   !== undefined) parts.push(opts.superuser   ? 'SUPERUSER'   : 'NOSUPERUSER');
    if (opts.canLogin    !== undefined) parts.push(opts.canLogin    ? 'LOGIN'       : 'NOLOGIN');
    if (opts.replication !== undefined) parts.push(opts.replication ? 'REPLICATION' : 'NOREPLICATION');
    if (parts.length === 0) return;
    await client.query(`ALTER ROLE ${client.escapeIdentifier(name)} WITH ${parts.join(' ')}`);
    audit.record({ category: 'user', action: 'alter', instanceId: instance.id, target: name, ok: true,
      meta: { superuser: String(opts.superuser), canLogin: String(opts.canLogin), replication: String(opts.replication) } });
  } catch (err: any) {
    audit.record({ category: 'user', action: 'alter', instanceId: instance.id, target: name, ok: false, error: err?.message ?? String(err) });
    throw err;
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
    audit.record({ category: 'user', action: 'password-change', instanceId: instance.id, target: roleName, ok: true });
  } catch (err: any) {
    audit.record({ category: 'user', action: 'password-change', instanceId: instance.id, target: roleName, ok: false, error: err?.message ?? String(err) });
    throw err;
  } finally {
    await client.end();
  }
}
