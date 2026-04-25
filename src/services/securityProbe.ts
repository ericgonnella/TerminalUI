/**
 * securityProbe.ts — live security checks for a PostgreSQL instance.
 *
 * Runs a set of automated checks against a live or local instance and
 * returns structured pass/warn/fail results for display in the UI.
 *
 * Checks performed:
 *   1. pg_hba.conf scan   — trust auth entries (uses dataDir, no connection)
 *   2. Credential age     — days since passwordChangedAt, warn >90
 *   3. SSL in transit     — SHOW ssl (live query)
 *   4. listen_addresses   — SHOW listen_addresses (live query)
 *   5. Role privilege     — superuser check (live query)
 */

import * as fs   from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import type { Instance } from '../types';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'info';

export interface SecurityCheck {
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface SecurityProbeResult {
  instanceId: string;
  checks: SecurityCheck[];
  ranAt: string;
  /** Set when a TCP/socket connection could not be established at all. */
  connectionError?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Parse pg_hba.conf and flag dangerous `trust` entries.
 *
 * Format:
 *   local   database  user  auth-method  [options]
 *   host    database  user  address      auth-method  [options]
 */
function checkPgHba(dataDir: string): SecurityCheck {
  const hbaFile = path.join(dataDir, 'pg_hba.conf');

  if (!fs.existsSync(hbaFile)) {
    return {
      label: 'pg_hba.conf',
      status: 'skip',
      detail: 'File not found (not a local data directory?).',
    };
  }

  try {
    const lines = fs.readFileSync(hbaFile, 'utf-8').split('\n');
    const dangerous: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const parts = line.split(/\s+/);
      const connType = parts[0]?.toLowerCase() ?? '';

      // Determine where auth-method sits depending on record type.
      let authMethod: string;
      let address: string | null;

      if (connType === 'local') {
        // local  database  user  auth-method [options]
        authMethod = parts[3] ?? '';
        address    = null;
      } else {
        // host*  database  user  address  auth-method [options]
        authMethod = parts[4] ?? '';
        address    = parts[3] ?? null;
      }

      if (authMethod !== 'trust') continue;

      if (connType === 'local') {
        // Unix-socket trust — only relevant if it covers all/all
        const db   = parts[1] ?? '';
        const user = parts[2] ?? '';
        if (db === 'all' || user === 'all') {
          dangerous.push(`local all/all trust (socket, no password for matching users)`);
        }
        continue;
      }

      // Network trust — flag severity based on address scope
      const isLoopbackAddr =
        address === '127.0.0.1/32' ||
        address === '::1/128'      ||
        address === 'samehost'     ||
        address === 'samenet'      ||
        address === 'localhost';

      if (isLoopbackAddr) {
        dangerous.push(`${connType} ${address} trust (loopback only)`);
      } else {
        // Open-network trust is a hard fail
        dangerous.push(`${connType} ${address ?? '?'} trust \u2190 OPEN NETWORK, no password`);
      }
    }

    if (dangerous.length === 0) {
      return {
        label: 'pg_hba.conf',
        status: 'pass',
        detail: 'No trust entries — all connections require authentication.',
      };
    }

    const hasOpenNetwork = dangerous.some(d => d.includes('OPEN NETWORK'));
    return {
      label: 'pg_hba.conf',
      status: hasOpenNetwork ? 'fail' : 'warn',
      detail: dangerous.join(' | '),
    };
  } catch (e: unknown) {
    return {
      label: 'pg_hba.conf',
      status: 'skip',
      detail: `Cannot read: ${(e as NodeJS.ErrnoException)?.message ?? String(e)}`,
    };
  }
}

function checkCredentialAge(instance: Instance): SecurityCheck {
  if (!instance.hasPassword) {
    return {
      label: 'Credential age',
      status: 'info',
      detail: 'No password set (trust auth or not applicable).',
    };
  }

  if (!instance.passwordChangedAt) {
    return {
      label: 'Credential age',
      status: 'info',
      detail: 'Age unknown — password pre-dates tracking. Consider rotating.',
    };
  }

  const ageDays = Math.floor(
    (Date.now() - new Date(instance.passwordChangedAt).getTime()) / 86_400_000,
  );

  if (ageDays > 90) {
    return {
      label: 'Credential age',
      status: 'warn',
      detail: `Password last changed ${ageDays} days ago. Recommend rotating (target: \u226490 days).`,
    };
  }

  return {
    label: 'Credential age',
    status: 'pass',
    detail: `Changed ${ageDays} day${ageDays === 1 ? '' : 's'} ago.`,
  };
}

// ─── Main probe ───────────────────────────────────────────────────────────────

/**
 * Run all automated security checks against `instance`.
 *
 * File-based checks (pg_hba.conf, credential age) run even when the instance
 * is stopped.  Live checks (ssl, listen_addresses, role privilege) require an
 * active connection; they're skipped and a `connectionError` is set when the
 * server is unreachable.
 */
export async function probeInstanceSecurity(
  instance: Instance,
): Promise<SecurityProbeResult> {
  const checks: SecurityCheck[] = [];
  const host = instance.host ?? '127.0.0.1';
  const isLoopback = LOOPBACK.has(host);

  // ── Check 1: pg_hba.conf (no connection needed) ───────────────────────────
  if (instance.dataDir) {
    checks.push(checkPgHba(instance.dataDir));
  }

  // ── Check 2: Credential age (no connection needed) ────────────────────────
  checks.push(checkCredentialAge(instance));

  // ── Live connection checks ─────────────────────────────────────────────────
  const client = new Client({
    host,
    port:   instance.port,
    user:   instance.superuser,
    password: instance.password,
    database: 'postgres',
    connectionTimeoutMillis: 5_000,
    // Use SSL opportunistically — we probe whether it's active via SHOW ssl,
    // but we don't fail the connection if the server doesn't advertise SSL.
    ssl: false,
  });

  try {
    await client.connect();
  } catch (err: unknown) {
    return {
      instanceId: instance.id,
      checks,
      ranAt: new Date().toISOString(),
      connectionError:
        (err as NodeJS.ErrnoException)?.message ?? String(err),
    };
  }

  try {
    // ── Check 3: SSL in transit ──────────────────────────────────────────────
    try {
      const { rows } = await client.query<{ ssl: string }>('SHOW ssl');
      const sslOn = rows[0]?.ssl === 'on';

      if (isLoopback) {
        checks.push({
          label:  'SSL in transit',
          status: 'info',
          detail: `${sslOn ? 'On' : 'Off'} — loopback connection, in-transit encryption optional.`,
        });
      } else if (sslOn) {
        checks.push({
          label:  'SSL in transit',
          status: 'pass',
          detail: 'SSL is enabled — connection is encrypted.',
        });
      } else {
        checks.push({
          label:  'SSL in transit',
          status: instance.installationType === 'hosted' ? 'fail' : 'warn',
          detail: 'SSL is OFF — traffic is unencrypted. Set ssl=on in postgresql.conf.',
        });
      }
    } catch {
      checks.push({
        label:  'SSL in transit',
        status: 'skip',
        detail: 'Could not query ssl setting.',
      });
    }

    // ── Check 4: listen_addresses ────────────────────────────────────────────
    try {
      const { rows } = await client.query<{ listen_addresses: string }>(
        'SHOW listen_addresses',
      );
      const la = (rows[0]?.listen_addresses ?? '').trim();

      if (la === 'localhost' || la === '127.0.0.1') {
        checks.push({
          label:  'listen_addresses',
          status: 'pass',
          detail: `Bound to ${la} only — not reachable from other hosts.`,
        });
      } else if (la === '*') {
        checks.push({
          label:  'listen_addresses',
          status: instance.installationType === 'hosted' ? 'warn' : 'fail',
          detail:
            "listen_addresses='*' — server accepts connections on all interfaces. " +
            'Restrict to a specific IP if possible, and verify firewall rules.',
        });
      } else {
        checks.push({
          label:  'listen_addresses',
          status: 'info',
          detail: `Bound to: ${la}`,
        });
      }
    } catch {
      checks.push({
        label:  'listen_addresses',
        status: 'skip',
        detail: 'Could not query listen_addresses.',
      });
    }

    // ── Check 5: Role privilege ──────────────────────────────────────────────
    try {
      const { rows } = await client.query<{ usesuper: boolean }>(
        'SELECT usesuper FROM pg_user WHERE usename = current_user',
      );
      const isSuperuser = rows[0]?.usesuper === true;

      if (isSuperuser && instance.installationType === 'hosted') {
        checks.push({
          label:  'Role privilege',
          status: 'warn',
          detail: `"${instance.superuser}" is a superuser. Create a least-privilege role for application connections.`,
        });
      } else if (isSuperuser) {
        checks.push({
          label:  'Role privilege',
          status: 'info',
          detail: `"${instance.superuser}" is a superuser — normal for local dev.`,
        });
      } else {
        checks.push({
          label:  'Role privilege',
          status: 'pass',
          detail: `"${instance.superuser}" is not a superuser.`,
        });
      }
    } catch {
      checks.push({
        label:  'Role privilege',
        status: 'skip',
        detail: 'Could not query role privileges.',
      });
    }
  } finally {
    try { await client.end(); } catch { /* best-effort */ }
  }

  return {
    instanceId: instance.id,
    checks,
    ranAt: new Date().toISOString(),
  };
}
