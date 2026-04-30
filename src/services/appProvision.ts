/**
 * appProvision.ts — Netlify-friendly application database provisioning.
 *
 * Implements the flow described in `pgmanager-netlify-integration-spec.md`:
 * given a running PGManager instance whose superuser credentials we already
 * own, create (idempotently) a *dedicated* application database and login
 * role, generate a strong random password, persist it in the encrypted
 * vault, and produce a `DATABASE_URL` ready to drop into a VPS backend
 * `.env` file.
 *
 * The browser / Netlify frontend NEVER sees these credentials. They are
 * intended for a server-side API process running on the same VPS, talking
 * to PostgreSQL on `127.0.0.1`.
 *
 * Cross-platform notes:
 *   - All work is done over a regular `pg` connection — no shell calls,
 *     so this runs identically on Windows and Linux.
 *   - File modes (0o600 / 0o700) are best-effort: Windows silently ignores
 *     them. The vault and config layer already follow the same convention.
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { Client } from 'pg';
import { randomBytes } from 'crypto';
import type { Instance } from '../types';
import * as audit from './auditLog';
import { setSecret, getSecret, deleteSecret } from './vault';

// ─── Validation ───────────────────────────────────────────────────────────────

/** PostgreSQL identifier safety: [a-z_][a-z0-9_]{0,62}. We deliberately reject
 *  uppercase and quoted identifiers — the resulting URL would need quoting in
 *  every consumer and is a footgun for application code. */
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function validateAppIdentifier(value: string, label: string): {
  ok: boolean;
  reason: string | null;
} {
  const v = value.trim();
  if (!v) return { ok: false, reason: `${label} is required.` };
  if (v.length > 63) {
    return { ok: false, reason: `${label} must be 63 characters or fewer (PostgreSQL limit).` };
  }
  if (!IDENT_RE.test(v)) {
    return {
      ok: false,
      reason: `${label} must start with a lowercase letter or underscore and contain only [a-z0-9_].`,
    };
  }
  // Block obvious reserved / privileged role names
  const RESERVED = new Set([
    'postgres', 'pg_signal_backend', 'pg_read_all_data', 'pg_write_all_data',
    'pg_monitor', 'pg_read_all_stats', 'pg_read_all_settings', 'pg_stat_scan_tables',
    'pg_database_owner', 'public', 'template0', 'template1', 'session_user',
    'current_user', 'current_role',
  ]);
  if (RESERVED.has(v)) {
    return { ok: false, reason: `${label} "${v}" is reserved by PostgreSQL.` };
  }
  return { ok: true, reason: null };
}

// ─── Password generation ──────────────────────────────────────────────────────

/** Generate a 48-character hex password (24 bytes of entropy = 192 bits).
 *  Equivalent to `openssl rand -hex 24` in the upstream spec. We use hex
 *  rather than base64 so the password is URL-safe without further encoding,
 *  which keeps the resulting `DATABASE_URL` clean. */
export function generateAppPassword(): string {
  return randomBytes(24).toString('hex');
}

// ─── Connection helper ────────────────────────────────────────────────────────

function adminClient(instance: Instance): Client {
  return new Client({
    host:     instance.host ?? '127.0.0.1',
    port:     instance.port,
    user:     instance.superuser,
    password: instance.password,
    database: 'postgres',
    connectionTimeoutMillis: 5000,
  });
}

// ─── Connection-string builders ───────────────────────────────────────────────

/** Build the libpq DATABASE_URL the backend should consume.
 *  Always pins the host to `127.0.0.1` regardless of `instance.host`, because
 *  this URL is meant for a VPS backend talking to PG over loopback. */
export function buildAppDatabaseUrl(
  instance: Instance,
  appUser: string,
  appPassword: string,
  appDb: string,
): string {
  // Per the spec, the backend should always reach Postgres on loopback.
  // We deliberately ignore instance.host so a misconfigured "hosted" instance
  // doesn't accidentally hand the user a 0.0.0.0/public URL.
  return `postgresql://${appUser}:${encodeURIComponent(appPassword)}@127.0.0.1:${instance.port}/${appDb}`;
}

export function buildRedactedAppDatabaseUrl(
  instance: Instance,
  appUser: string,
  appDb: string,
): string {
  return `postgresql://${appUser}:****@127.0.0.1:${instance.port}/${appDb}`;
}

// ─── Vault keying ─────────────────────────────────────────────────────────────

function passwordKey(instanceId: string, appUser: string, appDb: string): string {
  return `app:${instanceId}:${appDb}:${appUser}:password`;
}

export function getStoredAppPassword(
  instance: Instance, appUser: string, appDb: string,
): string | undefined {
  return getSecret(passwordKey(instance.id, appUser, appDb));
}

export function deleteStoredAppPassword(
  instance: Instance, appUser: string, appDb: string,
): void {
  deleteSecret(passwordKey(instance.id, appUser, appDb));
}

// ─── Provisioning ─────────────────────────────────────────────────────────────

export interface ProvisionAppOptions {
  appDb:     string;
  appUser:   string;
  /** When omitted, a fresh 48-char hex password is generated. */
  password?: string;
  /** When true, ALTER ROLE WITH PASSWORD even if the role already exists.
   *  When false, an existing role's password is left untouched UNLESS
   *  `password` was supplied explicitly. */
  rotatePasswordIfRoleExists?: boolean;
}

export interface ProvisionAppResult {
  appDb:        string;
  appUser:      string;
  password:     string;
  databaseUrl:  string;
  redactedUrl:  string;
  /** True if the role already existed before this call. */
  roleExisted:  boolean;
  /** True if the database already existed before this call. */
  databaseExisted: boolean;
  /** True when the stored password was changed (either created or rotated). */
  passwordWritten: boolean;
}

/**
 * Idempotent provisioning. Mirrors the bash flow from the integration spec
 * but runs entirely through the `pg` driver — no shell, no PGPASSWORD env,
 * works identically on Windows and Linux.
 *
 * Steps:
 *   1. Validate inputs (DB name, user name).
 *   2. Connect as the instance superuser.
 *   3. CREATE ROLE if missing, otherwise optionally rotate password.
 *   4. CREATE DATABASE owned by the role if missing.
 *   5. GRANT CONNECT + minimal default privileges so the app role can
 *      actually use the DB it owns. (Owners already get everything,
 *      so this is a belt-and-braces step for the rare case where the
 *      DB already existed under a different owner.)
 *   6. Persist the password to the encrypted vault.
 *   7. Return the assembled DATABASE_URL.
 */
export async function provisionAppDatabase(
  instance: Instance,
  opts:     ProvisionAppOptions,
): Promise<ProvisionAppResult> {
  const dbCheck = validateAppIdentifier(opts.appDb, 'Database name');
  if (!dbCheck.ok) throw new Error(dbCheck.reason ?? 'Invalid database name.');

  const userCheck = validateAppIdentifier(opts.appUser, 'Role name');
  if (!userCheck.ok) throw new Error(userCheck.reason ?? 'Invalid role name.');

  const appDb   = opts.appDb.trim();
  const appUser = opts.appUser.trim();

  // Refuse to provision under the instance superuser — defeats the purpose.
  if (appUser === instance.superuser) {
    throw new Error(
      `Refusing to provision app credentials under the superuser "${instance.superuser}". ` +
      `Choose a dedicated, non-privileged role (e.g. "${appDb}_app").`,
    );
  }

  const password = opts.password ?? generateAppPassword();

  const client = adminClient(instance);
  await client.connect();

  let roleExisted     = false;
  let databaseExisted = false;
  let passwordWritten = false;

  try {
    // ── Step 1: role ──────────────────────────────────────────────────────
    const roleRes = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
      [appUser],
    );
    roleExisted = !!roleRes.rows[0]?.exists;

    const escUser = client.escapeIdentifier(appUser);
    const escDb   = client.escapeIdentifier(appDb);

    if (!roleExisted) {
      // CREATE ROLE doesn't accept bind params for PASSWORD; we use a
      // followup ALTER ROLE which does, so the password never appears in
      // the SQL string itself.
      await client.query(`CREATE ROLE ${escUser} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      await client.query(
        `ALTER ROLE ${escUser} WITH ENCRYPTED PASSWORD $1`,
        [password],
      );
      passwordWritten = true;
    } else if (opts.password !== undefined || opts.rotatePasswordIfRoleExists) {
      await client.query(
        `ALTER ROLE ${escUser} WITH ENCRYPTED PASSWORD $1`,
        [password],
      );
      passwordWritten = true;
    }

    // ── Step 2: database ──────────────────────────────────────────────────
    const dbRes = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
      [appDb],
    );
    databaseExisted = !!dbRes.rows[0]?.exists;

    if (!databaseExisted) {
      // CREATE DATABASE cannot run inside a transaction block — pg's default
      // auto-commit mode is fine here since we're not in a tx.
      await client.query(`CREATE DATABASE ${escDb} OWNER ${escUser}`);
    } else {
      // If the DB exists but isn't owned by the app role, surface that
      // clearly. We do NOT silently change ownership — that's a foot-gun
      // and the operator should make the call.
      const ownerRes = await client.query<{ owner: string }>(
        `SELECT pg_catalog.pg_get_userbyid(d.datdba) AS owner
           FROM pg_catalog.pg_database d
          WHERE d.datname = $1`,
        [appDb],
      );
      const owner = ownerRes.rows[0]?.owner;
      if (owner && owner !== appUser) {
        // Attempt the safest possible follow-up: ensure the app role at
        // least has CONNECT + TEMP on the existing database.
        await client.query(
          `GRANT CONNECT, TEMPORARY ON DATABASE ${escDb} TO ${escUser}`,
        );
      }
    }

    audit.record({
      category:   'database',
      action:     'provision-app',
      instanceId: instance.id,
      database:   appDb,
      target:     appUser,
      ok:         true,
      meta: {
        roleExisted,
        databaseExisted,
        passwordWritten,
      },
    });
  } catch (err: unknown) {
    audit.record({
      category:   'database',
      action:     'provision-app',
      instanceId: instance.id,
      database:   appDb,
      target:     appUser,
      ok:         false,
      error:      err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await client.end();
  }

  // Persist password to the vault only AFTER the SQL succeeded — otherwise
  // we'd be storing credentials for a user that doesn't exist.
  if (passwordWritten) {
    setSecret(passwordKey(instance.id, appUser, appDb), password);
  }

  // If we didn't write a new password but one is already on file, recover it
  // so callers always get a usable URL back.
  const finalPassword = passwordWritten
    ? password
    : (getStoredAppPassword(instance, appUser, appDb) ?? password);

  const databaseUrl = buildAppDatabaseUrl(instance, appUser, finalPassword, appDb);
  const redactedUrl = buildRedactedAppDatabaseUrl(instance, appUser, appDb);

  return {
    appDb,
    appUser,
    password:        finalPassword,
    databaseUrl,
    redactedUrl,
    roleExisted,
    databaseExisted,
    passwordWritten,
  };
}

// ─── .env export ──────────────────────────────────────────────────────────────

/**
 * Render the canonical backend `.env` snippet for this provisioning result.
 * Only includes the keys the spec mandates (DATABASE_URL, PORT, CORS_ORIGIN).
 * `corsOrigin` is left as a placeholder when not provided so the operator
 * remembers to fill it in before deploying the API.
 */
export function renderBackendEnv(
  result:       ProvisionAppResult,
  opts: { backendPort?: number; corsOrigin?: string } = {},
): string {
  const lines = [
    '# Generated by pgmanager — VPS backend API only. Do NOT commit.',
    '# Do NOT put DATABASE_URL into Netlify environment variables.',
    `DATABASE_URL=${result.databaseUrl}`,
    `PORT=${opts.backendPort ?? 3100}`,
    `CORS_ORIGIN=${opts.corsOrigin ?? 'https://your-netlify-site.netlify.app'}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Persist the rendered `.env` to disk under
 *   ~/.pgmanager/env/<instanceName>-<appDb>.env
 * with mode 0o600 (best-effort on Windows).
 *
 * Returns the absolute path written. Throws on filesystem errors.
 */
export function saveBackendEnvFile(
  instance: Instance,
  result:   ProvisionAppResult,
  opts: { backendPort?: number; corsOrigin?: string } = {},
): string {
  const dir = path.join(os.homedir(), '.pgmanager', 'env');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { fs.chmodSync(dir, 0o700); } catch { /* Windows / EPERM */ }
  }

  // Sanitize instance name for use as a filename. The instance name is user
  // input; pin it to [A-Za-z0-9._-] to avoid path-traversal in the off chance
  // someone embedded slashes or dots.
  const safeName = instance.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  const safeDb   = result.appDb.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  const file     = path.join(dir, `${safeName}-${safeDb}.env`);

  fs.writeFileSync(file, renderBackendEnv(result, opts), {
    encoding: 'utf-8',
    mode:     0o600,
  });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / EPERM */ }

  return file;
}
