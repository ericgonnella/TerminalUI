/**
 * projectDatabase.ts
 *
 * Full project database provisioning lifecycle implementing the pgManager
 * Integration Spec (pgmanager_integration_spec.md).
 *
 * Responsibilities:
 *   - Access mode management (internal → production_vpn)
 *   - UFW status detection and targeted rule management
 *   - pg_hba.conf managed block per project database
 *   - Connection string generation for each access mode + backend location
 *   - Health checks: pg_isready, local SQL, listener (ss/netstat), firewall
 *   - Warning generation (public exposure, missing backups, etc.)
 *   - Rollback command generation for every change made
 *   - Framework .env templates (Node, Prisma, Drizzle, Netlify)
 *   - SQL permission template (runtime user + optional migration user)
 *
 * Security rules:
 *   - All spawn calls use array arguments — no shell string interpolation.
 *   - Passwords are never logged or embedded in rollback strings.
 *   - pg_hba.conf edits use tagged blocks for clean, targeted removal.
 *   - UFW rules are recorded so they can be rolled back exactly.
 */

import { spawn }        from 'child_process';
import * as fs          from 'fs';
import * as path        from 'path';
import { Client }       from 'pg';
import type {
  Instance,
  AccessMode,
  BackendLocation,
  EnvTarget,
  ProjectWarning,
  ProjectHealthCheck,
} from '../types';
import * as audit from './auditLog';

// ─── Constants ────────────────────────────────────────────────────────────────

const HBA_BEGIN = (tag: string) => `# BEGIN pgmanager-project-db ${tag}`;
const HBA_END   = (tag: string) => `# END pgmanager-project-db ${tag}`;

/** Tag format: `<instanceId>:<databaseName>` — stays ≤ 80 chars. */
function hbaTag(instanceId: string, dbName: string): string {
  // Sanitise for safe embedding as a comment token (no newlines, no control chars).
  const safe = (s: string) => s.replace(/[\r\n\t\0]/g, '_').slice(0, 32);
  return `${safe(instanceId)}:${safe(dbName)}`;
}

// ─── Access mode metadata ─────────────────────────────────────────────────────

export interface AccessModeInfo {
  label:           string;
  description:     string;
  securityLevel:   'very_high' | 'high' | 'medium_high' | 'medium' | 'low';
  requiresPublicIp: boolean;
  requiresCidrs:   boolean;
  isTemporary:     boolean;
  warnPublic:      boolean;
}

export const ACCESS_MODE_INFO: Record<AccessMode, AccessModeInfo> = {
  internal: {
    label:            'Internal / Same-VPS',
    description:      'Backend and database run on the same VPS. Loopback only — no public exposure.',
    securityLevel:    'high',
    requiresPublicIp: false,
    requiresCidrs:    false,
    isTemporary:      false,
    warnPublic:       false,
  },
  testing_open: {
    label:            'Open Testing (public, unrestricted)',
    description:      'PostgreSQL reachable from anywhere. TEMPORARY — set a reminder to close.',
    securityLevel:    'low',
    requiresPublicIp: true,
    requiresCidrs:    false,
    isTemporary:      true,
    warnPublic:       true,
  },
  testing_allowlist: {
    label:            'Allowlist Testing (specific IPs)',
    description:      'External access limited to specified IPs. TEMPORARY — switch to production mode.',
    securityLevel:    'medium',
    requiresPublicIp: true,
    requiresCidrs:    true,
    isTemporary:      true,
    warnPublic:       false,
  },
  production_local: {
    label:            'Production Local (same VPS)',
    description:      'Backend and database on the same VPS. Public port closed. Hardened.',
    securityLevel:    'high',
    requiresPublicIp: false,
    requiresCidrs:    false,
    isTemporary:      false,
    warnPublic:       false,
  },
  production_allowlist: {
    label:            'Production Allowlist (external backend)',
    description:      'Backend on another server. Only backend IPs allowed. TLS recommended.',
    securityLevel:    'medium_high',
    requiresPublicIp: true,
    requiresCidrs:    true,
    isTemporary:      false,
    warnPublic:       false,
  },
  production_vpn: {
    label:            'Production VPN / Private Network',
    description:      'Database binds to VPN/private IP. Public port completely closed.',
    securityLevel:    'very_high',
    requiresPublicIp: false,
    requiresCidrs:    false,
    isTemporary:      false,
    warnPublic:       false,
  },
};

export const BACKEND_LOCATION_LABELS: Record<BackendLocation, string> = {
  same_vps:          'Same VPS (backend + DB on one server)',
  same_vps_docker:   'Docker on same VPS',
  external_vps:      'External VPS / server',
  netlify_functions: 'Netlify Functions',
  vercel_functions:  'Vercel Functions',
  local_dev_machine: 'Local dev machine',
  unknown:           'Unknown / not sure yet',
};

// ─── Connection string generation ─────────────────────────────────────────────

export interface ConnectionStrings {
  /** Local loopback URL — always generated. */
  internal:    string;
  /** URL using the public IP — null when access mode has no public exposure. */
  external:    string | null;
  /** Docker-aware URLs — non-empty when backend is Docker on the same VPS. */
  dockerHints: string[];
  /** The single best URL to paste into the backend .env. */
  recommended: string;
}

/**
 * Build the set of connection strings appropriate for the chosen access mode
 * and backend location. Passwords are always URL-encoded to handle any
 * special characters safely.
 *
 * The `password` parameter MUST NOT be logged by callers.
 */
export function buildConnectionStrings(
  instance:        Instance,
  appUser:         string,
  password:        string,
  appDb:           string,
  mode:            AccessMode,
  backendLocation: BackendLocation,
  publicIp:        string | undefined,
  useTls:          boolean,
): ConnectionStrings {
  const encodedPw = encodeURIComponent(password);
  const port      = instance.port;
  const sslSuffix = useTls ? '?sslmode=require' : '';

  const internal = `postgresql://${appUser}:${encodedPw}@127.0.0.1:${port}/${appDb}${sslSuffix}`;

  let external: string | null = null;
  if (publicIp && ACCESS_MODE_INFO[mode].requiresPublicIp) {
    external = `postgresql://${appUser}:${encodedPw}@${publicIp}:${port}/${appDb}${sslSuffix}`;
  }

  // Docker on same VPS — multiple plausible hosts.
  const dockerHints: string[] = [];
  if (backendLocation === 'same_vps_docker') {
    dockerHints.push(
      `postgresql://${appUser}:${encodedPw}@host.docker.internal:${port}/${appDb}${sslSuffix}`,
      `postgresql://${appUser}:${encodedPw}@172.17.0.1:${port}/${appDb}${sslSuffix}`,
    );
  }

  // Determine recommended URL.
  let recommended = internal;
  if (backendLocation === 'same_vps_docker') {
    recommended = `postgresql://${appUser}:${encodedPw}@host.docker.internal:${port}/${appDb}${sslSuffix}`;
  } else if (external && (
    backendLocation === 'external_vps'    ||
    backendLocation === 'netlify_functions' ||
    backendLocation === 'vercel_functions'  ||
    backendLocation === 'local_dev_machine'
  )) {
    recommended = external;
  }

  return { internal, external, dockerHints, recommended };
}

/** Redacted version safe for display / logging. */
export function redactConnectionStrings(cs: ConnectionStrings): {
  internal: string;
  external: string | null;
  recommended: string;
} {
  const redact = (s: string) => s.replace(/:([^:@]+)@/, ':****@');
  return {
    internal:    redact(cs.internal),
    external:    cs.external ? redact(cs.external) : null,
    recommended: redact(cs.recommended),
  };
}

// ─── SQL permission template ──────────────────────────────────────────────────

/**
 * Returns the SQL to grant the runtime app user the standard read/write
 * permissions on the named database. Also optionally creates a separate
 * migration role with CREATE/ALTER/DROP rights.
 *
 * These statements must be run while connected to `appDb` (not postgres).
 */
export function buildPermissionSql(
  appDb:            string,
  appUser:          string,
  migrationUser?:   string,
): string {
  const escDb   = pgEscapeIdent(appDb);
  const escUser = pgEscapeIdent(appUser);

  const lines: string[] = [
    `-- Runtime app user: minimal read/write permissions`,
    `GRANT CONNECT ON DATABASE ${escDb} TO ${escUser};`,
    ``,
    `\\c ${escDb}`,
    ``,
    `GRANT USAGE ON SCHEMA public TO ${escUser};`,
    `GRANT CREATE ON SCHEMA public TO ${escUser};`,
    ``,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${escUser};`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${escUser};`,
    ``,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public`,
    `  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${escUser};`,
    ``,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public`,
    `  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${escUser};`,
  ];

  if (migrationUser) {
    const escMig = pgEscapeIdent(migrationUser);
    lines.push(
      ``,
      `-- Migration user: full schema management rights`,
      `GRANT CONNECT ON DATABASE ${escDb} TO ${escMig};`,
      `GRANT USAGE, CREATE ON SCHEMA public TO ${escMig};`,
      `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${escMig};`,
      `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${escMig};`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public`,
      `  GRANT ALL PRIVILEGES ON TABLES TO ${escMig};`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public`,
      `  GRANT ALL PRIVILEGES ON SEQUENCES TO ${escMig};`,
    );
  }

  return lines.join('\n');
}

/** Minimal safe SQL identifier quoting for display-only SQL templates.
 *  Doubles any existing double-quotes in the identifier. */
function pgEscapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ─── .env template generation ─────────────────────────────────────────────────

export function renderEnvTemplate(
  cs:             ConnectionStrings,
  target:         EnvTarget,
  backendPort:    number = 3100,
  corsOrigin:     string = 'https://your-site.netlify.app',
): string {
  const redacted = redactConnectionStrings(cs);

  switch (target) {
    case 'node_express':
      return [
        '# Generated by pgManager — VPS backend only. Do NOT commit.',
        `DATABASE_URL=${cs.recommended}`,
        `PORT=${backendPort}`,
        `NODE_ENV=production`,
        `CORS_ORIGIN=${corsOrigin}`,
        '',
      ].join('\n');

    case 'prisma':
      return [
        '# Prisma — schema/prisma/.env or .env',
        '# Do NOT expose to Netlify/Vercel env vars.',
        `DATABASE_URL="${cs.recommended}"`,
        '',
      ].join('\n');

    case 'drizzle':
      return [
        '# Drizzle ORM — .env',
        '# Do NOT expose to Netlify/Vercel env vars.',
        `DATABASE_URL=${cs.recommended}`,
        '',
      ].join('\n');

    case 'netlify_frontend':
      return [
        '# Netlify site .env — ONLY the API base URL goes here.',
        '# DATABASE_URL must NEVER be placed in Netlify environment variables.',
        `VITE_API_BASE_URL=https://api.your-domain.com`,
        '',
        '# The following is for documentation only — do not set in Netlify UI:',
        `# DATABASE_URL=${redacted.recommended}  ← backend VPS only`,
        '',
      ].join('\n');

    case 'external_vps':
      return [
        '# External VPS backend .env',
        '# PostgreSQL is accessed over the public internet — ensure TLS + allowlist.',
        `DATABASE_URL=${cs.recommended}`,
        `PORT=${backendPort}`,
        `NODE_ENV=production`,
        `CORS_ORIGIN=${corsOrigin}`,
        '',
      ].join('\n');

    default:
      return `DATABASE_URL=${cs.recommended}\n`;
  }
}

// ─── UFW status detection ─────────────────────────────────────────────────────

export type UfwPortStatus =
  | 'inactive'            // ufw is disabled
  | 'closed'              // ufw active, port not in rules
  | 'open_anywhere'       // ufw active, port open 0.0.0.0/any
  | 'open_allowlist'      // ufw active, port open only for specific IPs
  | 'unknown';            // could not determine

export interface UfwStatus {
  available:  boolean;
  status:     UfwPortStatus;
  activeRules: string[];   // raw matching lines from `ufw status`
}

export async function detectUfwStatus(port: number): Promise<UfwStatus> {
  if (process.platform !== 'linux') {
    return { available: false, status: 'unknown', activeRules: [] };
  }

  const hasUfw = await commandExists('ufw');
  if (!hasUfw) {
    return { available: false, status: 'unknown', activeRules: [] };
  }

  const lines: string[] = [];
  const code = await spawnCollect('ufw', ['status', 'verbose'], lines);

  if (code !== 0) {
    return { available: true, status: 'unknown', activeRules: [] };
  }

  const output = lines.join('\n');

  if (/Status:\s+inactive/i.test(output)) {
    return { available: true, status: 'inactive', activeRules: [] };
  }

  const portStr  = String(port);
  const matching = lines.filter(l => l.includes(portStr));

  if (matching.length === 0) {
    return { available: true, status: 'closed', activeRules: [] };
  }

  // Check for open-to-anywhere rule: `<port>/tcp  ALLOW IN  Anywhere`
  const openAnywhere = matching.some(l =>
    /anywhere|0\.0\.0\.0\/0|::\s*\/0/i.test(l) && !/DENY/i.test(l),
  );

  if (openAnywhere) {
    return { available: true, status: 'open_anywhere', activeRules: matching };
  }

  return { available: true, status: 'open_allowlist', activeRules: matching };
}

// ─── UFW rule management ──────────────────────────────────────────────────────

export interface UfwRuleResult {
  ok:              boolean;
  message:         string;
  addedRules:      string[];   // commands added (for rollback)
  rollbackCmds:    string[];   // exact `ufw delete ...` commands
}

/**
 * Open a PostgreSQL port to the public internet (testing_open mode).
 * Generates rollback commands so it can be undone cleanly.
 */
export async function addUfwOpenRule(port: number): Promise<UfwRuleResult> {
  const rule    = `${port}/tcp`;
  const rollback = `sudo ufw delete allow ${rule}`;

  if (process.platform !== 'linux') {
    return {
      ok: false,
      message: `UFW is Linux-only. Open port ${port}/tcp manually in your host firewall.`,
      addedRules:   [],
      rollbackCmds: [],
    };
  }

  if (!(await commandExists('ufw'))) {
    return {
      ok: false,
      message: `ufw not found. Open port ${port}/tcp manually.`,
      addedRules:   [],
      rollbackCmds: [],
    };
  }

  const lines: string[] = [];
  const code = await spawnCollect('ufw', ['allow', rule], lines);

  audit.record({
    category: 'instance',
    action:   'ufw-open-port',
    target:   rule,
    ok:       code === 0,
    meta:     { port },
  });

  return {
    ok:           code === 0,
    message:      lines.join(' ') || (code === 0 ? 'Rule added.' : 'ufw exited non-zero.'),
    addedRules:   code === 0 ? [rule] : [],
    rollbackCmds: code === 0 ? [rollback] : [],
  };
}

/**
 * Add an IP-specific UFW rule (testing_allowlist / production_allowlist).
 * Each CIDR gets its own rule so they can be individually revoked.
 */
export async function addUfwAllowlistRules(
  port:  number,
  cidrs: string[],
): Promise<UfwRuleResult> {
  if (process.platform !== 'linux') {
    return {
      ok: false,
      message: `UFW is Linux-only. Add firewall rules for port ${port}/tcp manually.`,
      addedRules:   [],
      rollbackCmds: [],
    };
  }

  if (!(await commandExists('ufw'))) {
    return {
      ok: false,
      message: `ufw not found. Add firewall rules for port ${port}/tcp manually.`,
      addedRules:   [],
      rollbackCmds: [],
    };
  }

  const added:    string[] = [];
  const rollback: string[] = [];
  let   lastMsg             = '';

  for (const cidr of cidrs) {
    const lines: string[] = [];
    const code  = await spawnCollect(
      'ufw',
      ['allow', 'from', cidr, 'to', 'any', 'port', String(port), 'proto', 'tcp'],
      lines,
    );

    audit.record({
      category: 'instance',
      action:   'ufw-allowlist',
      target:   cidr,
      ok:       code === 0,
      meta:     { port, cidr },
    });

    lastMsg = lines.join(' ');

    if (code === 0) {
      added.push(cidr);
      rollback.push(`sudo ufw delete allow from ${cidr} to any port ${port} proto tcp`);
    }
  }

  return {
    ok:           added.length === cidrs.length,
    message:      lastMsg || (added.length > 0 ? `Added ${added.length} rule(s).` : 'Failed to add rules.'),
    addedRules:   added,
    rollbackCmds: rollback,
  };
}

/**
 * Close the port completely (remove open-to-anywhere rule).
 * Used when rolling back testing_open or resetting to internal mode.
 */
export async function removeUfwOpenRule(port: number): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== 'linux' || !(await commandExists('ufw'))) {
    return { ok: false, message: 'UFW not available on this platform.' };
  }

  const lines: string[] = [];
  const code = await spawnCollect('ufw', ['delete', 'allow', `${port}/tcp`], lines);

  audit.record({
    category: 'instance',
    action:   'ufw-close-port',
    target:   String(port),
    ok:       code === 0,
    meta:     { port },
  });

  return {
    ok:      code === 0,
    message: lines.join(' ') || (code === 0 ? 'Rule removed.' : 'ufw delete returned non-zero.'),
  };
}

/**
 * Remove IP-specific UFW allowlist rules.
 */
export async function removeUfwAllowlistRules(
  port:  number,
  cidrs: string[],
): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== 'linux' || !(await commandExists('ufw'))) {
    return { ok: false, message: 'UFW not available on this platform.' };
  }

  const errors: string[] = [];

  for (const cidr of cidrs) {
    const lines: string[] = [];
    const code = await spawnCollect(
      'ufw',
      ['delete', 'allow', 'from', cidr, 'to', 'any', 'port', String(port), 'proto', 'tcp'],
      lines,
    );
    if (code !== 0) errors.push(cidr);
  }

  audit.record({
    category: 'instance',
    action:   'ufw-remove-allowlist',
    target:   cidrs.join(','),
    ok:       errors.length === 0,
    meta:     { port },
  });

  return {
    ok:      errors.length === 0,
    message: errors.length > 0 ? `Failed for: ${errors.join(', ')}` : 'Rules removed.',
  };
}

// ─── pg_hba.conf managed block ────────────────────────────────────────────────

export interface HbaRule {
  database: string;
  user:     string;
  cidr:     string;
  useTls:   boolean;
}

/**
 * Write (or replace) a tagged pg_hba.conf block for a specific project database.
 * The block is scoped to `database` and `user` so it only affects this project.
 * Existing blocks for other projects are untouched.
 *
 * For testing_open mode, cidr should be ['0.0.0.0/0', '::/0'].
 * For allowlist modes, cidr is the list of allowed sources.
 * For internal/production_local modes, rules are removed entirely.
 */
export function writeProjectHbaBlock(
  dataDir:    string,
  instanceId: string,
  dbName:     string,
  rules:      HbaRule[],
): void {
  const hbaPath = path.join(dataDir, 'pg_hba.conf');
  const hba     = fs.readFileSync(hbaPath, 'utf8');
  const tag     = hbaTag(instanceId, dbName);
  const begin   = HBA_BEGIN(tag);
  const end     = HBA_END(tag);

  const ruleLines = rules.map(r => {
    const type = r.useTls ? 'hostssl' : 'host';
    return `${type.padEnd(8)} ${r.database.padEnd(16)} ${r.user.padEnd(16)} ${r.cidr.padEnd(20)} scram-sha-256`;
  });

  const block = [
    begin,
    '# Managed by pgManager — do not edit by hand.',
    ...ruleLines,
    end,
    '',
  ].join('\n');

  const i = hba.indexOf(begin);
  let next: string;

  if (i >= 0) {
    const j = hba.indexOf(end, i);
    if (j < 0) {
      // Malformed — replace from begin to end of file.
      next = hba.slice(0, i) + block;
    } else {
      const before = hba.slice(0, i);
      const after  = hba.slice(j + end.length).replace(/^\n/, '');
      next = before + block + (after.startsWith('\n') || after === '' ? after : '\n' + after);
    }
  } else {
    next = (hba.endsWith('\n') ? hba : hba + '\n') + '\n' + block;
  }

  fs.writeFileSync(hbaPath, next, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(hbaPath, 0o600); } catch { /* Windows / EPERM */ }
}

/**
 * Remove the tagged pg_hba.conf block for this project database.
 * Used when switching to internal/loopback-only mode.
 */
export function removeProjectHbaBlock(
  dataDir:    string,
  instanceId: string,
  dbName:     string,
): boolean {
  const hbaPath = path.join(dataDir, 'pg_hba.conf');
  if (!fs.existsSync(hbaPath)) return false;

  const hba   = fs.readFileSync(hbaPath, 'utf8');
  const tag   = hbaTag(instanceId, dbName);
  const begin = HBA_BEGIN(tag);
  const end   = HBA_END(tag);

  const i = hba.indexOf(begin);
  if (i < 0) return false;

  const j = hba.indexOf(end, i);
  if (j < 0) return false;

  const before = hba.slice(0, i);
  const after  = hba.slice(j + end.length).replace(/^\n/, '');

  fs.writeFileSync(hbaPath, before + after, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(hbaPath, 0o600); } catch { /* Windows / EPERM */ }

  return true;
}

/**
 * Build the pg_hba.conf rules appropriate for the selected access mode.
 * Returns an empty array for modes that need no external rules (internal,
 * production_local, production_vpn — those operate over loopback).
 */
export function buildHbaRules(
  dbName:   string,
  appUser:  string,
  mode:     AccessMode,
  cidrs:    string[],
  useTls:   boolean,
): HbaRule[] {
  switch (mode) {
    case 'internal':
    case 'production_local':
    case 'production_vpn':
      // No external rules needed — loopback auth is handled by the default hba.
      return [];

    case 'testing_open':
      return [
        { database: dbName, user: appUser, cidr: '0.0.0.0/0', useTls: false },
        { database: dbName, user: appUser, cidr: '::/0',       useTls: false },
      ];

    case 'testing_allowlist':
    case 'production_allowlist':
      return cidrs.map(cidr => ({ database: dbName, user: appUser, cidr, useTls }));

    default:
      return [];
  }
}

// ─── Warning generation ───────────────────────────────────────────────────────

export function generateWarnings(
  mode:            AccessMode,
  backendLocation: BackendLocation,
  ufwStatus:       UfwStatus,
  useTls:          boolean,
  hasBackup:       boolean = false,
): ProjectWarning[] {
  const warnings: ProjectWarning[] = [];

  if (mode === 'testing_open') {
    warnings.push({
      level:   'error',
      code:    'PUBLIC_OPEN',
      message: 'PostgreSQL port is open to the entire internet. Use only for temporary testing. Set a reminder to close it.',
    });
  }

  if (ufwStatus.status === 'open_anywhere' && mode !== 'testing_open') {
    warnings.push({
      level:   'error',
      code:    'UFW_OPEN_ANYWHERE',
      message: `Firewall has port open to 0.0.0.0/0 but access mode is "${mode}". Run "Close Public Access" to fix.`,
    });
  }

  if (mode === 'production_allowlist' && !useTls) {
    warnings.push({
      level:   'warning',
      code:    'NO_TLS_EXTERNAL_PROD',
      message: 'Production external access without TLS. Consider enabling sslmode=require.',
    });
  }

  if ((backendLocation === 'netlify_functions' || backendLocation === 'vercel_functions') &&
      (mode === 'internal' || mode === 'production_local')) {
    warnings.push({
      level:   'error',
      code:    'SERVERLESS_LOOPBACK',
      message: `Netlify/Vercel Functions cannot reach a loopback-only database. Choose an allowlist or VPN mode.`,
    });
  }

  if (backendLocation === 'netlify_functions' || backendLocation === 'vercel_functions') {
    warnings.push({
      level:   'warning',
      code:    'SERVERLESS_DIRECT_DB',
      message: 'Serverless functions connecting directly to PostgreSQL — consider a connection pooler (PgBouncer/Supabase) for production.',
    });
  }

  if (!hasBackup && (mode === 'production_local' || mode === 'production_allowlist' || mode === 'production_vpn')) {
    warnings.push({
      level:   'warning',
      code:    'NO_BACKUP',
      message: 'No backup schedule configured for this production database.',
    });
  }

  return warnings;
}

// ─── Health checks ────────────────────────────────────────────────────────────

export interface HealthCheckOptions {
  instance: Instance;
  appUser:  string;
  appDb:    string;
  pgCtlBin: string;   // path to pg_isready binary (same dir as pg_ctl)
}

/**
 * Run the standard health check suite for a project database.
 * Results include detailed per-check messages for display.
 */
export async function runHealthChecks(
  opts: HealthCheckOptions,
): Promise<ProjectHealthCheck> {
  const { instance, appUser, appDb, pgCtlBin } = opts;
  const details: string[] = [];

  let pgIsReady:     ProjectHealthCheck['pgIsReady']     = 'skipped';
  let localSql:      ProjectHealthCheck['localSql']      = 'skipped';
  let listener:      ProjectHealthCheck['listener']      = 'skipped';
  let firewallCheck: ProjectHealthCheck['firewallCheck'] = 'skipped';

  // ── 1. pg_isready ──────────────────────────────────────────────────────────
  try {
    const pgIsReadyBin = path.join(path.dirname(pgCtlBin), 'pg_isready');
    const lines: string[] = [];
    const code  = await spawnCollect(
      pgIsReadyBin,
      ['-h', '127.0.0.1', '-p', String(instance.port)],
      lines,
    );
    pgIsReady = code === 0 ? 'passed' : 'failed';
    details.push(`pg_isready: ${lines.join(' ').trim() || (code === 0 ? 'accepting connections' : 'not ready')}`);
  } catch (e: unknown) {
    pgIsReady = 'failed';
    details.push(`pg_isready: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 2. Local SQL connection ────────────────────────────────────────────────
  // Connect as the instance superuser and verify the app DB exists.
  try {
    const client = new Client({
      host:                    '127.0.0.1',
      port:                    instance.port,
      user:                    instance.superuser,
      password:                instance.password,
      database:                appDb,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      const res = await client.query<{ now: string }>('SELECT now()::text AS now');
      localSql = 'passed';
      details.push(`local SQL: connected to "${appDb}" at ${res.rows[0]?.now}`);
    } finally {
      await client.end();
    }
  } catch (e: unknown) {
    localSql = 'failed';
    details.push(`local SQL: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 3. Listener check ─────────────────────────────────────────────────────
  if (process.platform === 'linux') {
    try {
      const lines: string[] = [];
      const code  = await spawnCollect('ss', ['-ltnp'], lines);
      if (code === 0) {
        const portStr   = String(instance.port);
        const matching  = lines.filter(l => l.includes(portStr));
        const hasPublic = matching.some(l => l.includes('0.0.0.0') || l.includes(':::'));
        const hasLocal  = matching.some(l => l.includes('127.0.0.1') || l.includes('::1'));

        if (matching.length === 0) {
          listener = 'failed';
          details.push(`listener: port ${instance.port} not found in ss output`);
        } else if (hasPublic) {
          listener = 'warning';
          details.push(`listener: port ${instance.port} bound on 0.0.0.0 (publicly accessible)`);
        } else if (hasLocal) {
          listener = 'passed';
          details.push(`listener: port ${instance.port} bound on loopback only`);
        } else {
          listener = 'passed';
          details.push(`listener: port ${instance.port} found (${matching[0].trim()})`);
        }
      } else {
        listener = 'skipped';
        details.push('listener: ss command returned non-zero');
      }
    } catch {
      listener = 'skipped';
      details.push('listener: ss not available');
    }
  } else {
    listener = 'skipped';
    details.push('listener check: Linux-only (ss)');
  }

  // ── 4. Firewall check ─────────────────────────────────────────────────────
  try {
    const ufwStatus = await detectUfwStatus(instance.port);
    if (!ufwStatus.available) {
      firewallCheck = 'skipped';
      details.push('firewall: ufw not available on this platform');
    } else if (ufwStatus.status === 'inactive') {
      firewallCheck = 'warning';
      details.push('firewall: ufw is inactive — no host firewall rules are in effect');
    } else if (ufwStatus.status === 'open_anywhere') {
      firewallCheck = 'warning';
      details.push('firewall: port is open to 0.0.0.0/0 (publicly accessible)');
    } else if (ufwStatus.status === 'open_allowlist') {
      firewallCheck = 'passed';
      details.push(`firewall: port open for specific IPs (${ufwStatus.activeRules.length} rule(s))`);
    } else if (ufwStatus.status === 'closed') {
      firewallCheck = 'passed';
      details.push('firewall: port is closed at the host firewall level');
    } else {
      firewallCheck = 'skipped';
      details.push('firewall: status unknown');
    }
  } catch {
    firewallCheck = 'skipped';
    details.push('firewall: check failed');
  }

  audit.record({
    category:   'database',
    action:     'health-check',
    instanceId: instance.id,
    database:   appDb,
    target:     appUser,
    ok:         pgIsReady === 'passed' && localSql === 'passed',
    meta: {
      pgIsReady,
      localSql,
      listener:      listener as string,
      firewallCheck: firewallCheck as string,
    },
  });

  return {
    checkedAt:     new Date().toISOString(),
    pgIsReady,
    localSql,
    listener,
    firewallCheck,
    details,
  };
}

// ─── Apply access mode ────────────────────────────────────────────────────────

export interface ApplyAccessModeOptions {
  instance:   Instance;
  appDb:      string;
  appUser:    string;
  mode:       AccessMode;
  cidrs:      string[];     // for allowlist modes
  useTls:     boolean;
  pgCtlBin:   string;       // used to reload postgres after hba change
}

export interface ApplyAccessModeResult {
  ok:              boolean;
  messages:        string[];
  hbaChanged:      boolean;
  firewallResult:  UfwRuleResult | null;
  rollbackCmds:    string[];
  restartRequired: boolean;
  warnings:        ProjectWarning[];
}

/**
 * Apply a complete access mode to a running instance:
 *   1. Compute pg_hba.conf rules for the mode.
 *   2. Write/remove the managed block.
 *   3. Apply UFW rules as needed.
 *   4. Signal postgres to reload configuration.
 *   5. Collect rollback commands.
 */
export async function applyAccessMode(
  opts: ApplyAccessModeOptions,
): Promise<ApplyAccessModeResult> {
  const { instance, appDb, appUser, mode, cidrs, useTls, pgCtlBin } = opts;
  const messages:     string[] = [];
  const rollbackCmds: string[] = [];
  let   hbaChanged             = false;
  let   firewallResult: UfwRuleResult | null = null;
  let   restartRequired                       = false;

  // ── 1. postgresql.conf — listen_addresses ─────────────────────────────────
  // For modes that need public access we must ensure postgres binds on all
  // interfaces (listen_addresses = '*').  For internal-only modes we don't
  // change it — the operator controls that at the instance level.
  const needsPublic = (mode === 'testing_open' || mode === 'testing_allowlist' || mode === 'production_allowlist');

  if (needsPublic && instance.dataDir) {
    const confPath = path.join(instance.dataDir, 'postgresql.conf');
    try {
      const conf = fs.readFileSync(confPath, 'utf8');
      const alreadyAll = /^\s*listen_addresses\s*=\s*'\*'/m.test(conf);
      if (!alreadyAll) {
        let updated: string;
        if (/^#?\s*listen_addresses\s*=/m.test(conf)) {
          updated = conf.replace(
            /^#?\s*listen_addresses\s*=.*$/m,
            "listen_addresses = '*'    # pgmanager: project-db external access",
          );
        } else {
          updated = (conf.endsWith('\n') ? conf : conf + '\n') +
                    "listen_addresses = '*'    # pgmanager: project-db external access\n";
        }
        fs.writeFileSync(confPath, updated, { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(confPath, 0o600); } catch { /* Windows */ }
        messages.push("postgresql.conf: listen_addresses set to '*' (full restart required)");
        restartRequired = true;
      } else {
        messages.push("postgresql.conf: listen_addresses already '*'");
      }
    } catch (e: unknown) {
      messages.push(`postgresql.conf update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 2. pg_hba.conf ─────────────────────────────────────────────────────────
  if (instance.dataDir) {
    const hbaRules = buildHbaRules(appDb, appUser, mode, cidrs, useTls);

    if (hbaRules.length > 0) {
      try {
        writeProjectHbaBlock(instance.dataDir, instance.id, appDb, hbaRules);
        hbaChanged = true;
        messages.push(`pg_hba.conf: wrote ${hbaRules.length} rule(s) for "${appDb}"`);
        rollbackCmds.push(
          `# To remove pg_hba.conf rules for project "${appDb}", delete the block between:`,
          `# ${HBA_BEGIN(hbaTag(instance.id, appDb))}`,
          `# ${HBA_END(hbaTag(instance.id, appDb))}`,
        );
      } catch (e: unknown) {
        messages.push(`pg_hba.conf update failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      // Internal/production_local/vpn — remove any existing external rules.
      const removed = removeProjectHbaBlock(instance.dataDir, instance.id, appDb);
      if (removed) {
        hbaChanged = true;
        messages.push(`pg_hba.conf: removed external rules for "${appDb}" (internal mode)`);
      } else {
        messages.push(`pg_hba.conf: no external rules to remove`);
      }
    }
  }

  // ── 3. UFW ─────────────────────────────────────────────────────────────────
  if (mode === 'testing_open') {
    firewallResult = await addUfwOpenRule(instance.port);
    messages.push(`UFW: ${firewallResult.message}`);
    rollbackCmds.push(...firewallResult.rollbackCmds);

  } else if (mode === 'testing_allowlist' || mode === 'production_allowlist') {
    firewallResult = await addUfwAllowlistRules(instance.port, cidrs);
    messages.push(`UFW: ${firewallResult.message}`);
    rollbackCmds.push(...firewallResult.rollbackCmds);

  } else {
    // Internal / production_local / vpn — close open rules if present.
    const ufwStatus = await detectUfwStatus(instance.port);
    if (ufwStatus.status === 'open_anywhere') {
      const r = await removeUfwOpenRule(instance.port);
      messages.push(`UFW: closed public access — ${r.message}`);
    } else {
      messages.push('UFW: port already closed or ufw not active');
    }
  }

  // ── 4. Reload / restart postgres ────────────────────────────────────────────
  if (hbaChanged && !restartRequired) {
    try {
      const reloadLines: string[] = [];
      const reloadCode = await spawnCollect(
        pgCtlBin,
        ['-D', instance.dataDir ?? '', 'reload'],
        reloadLines,
      );
      if (reloadCode === 0) {
        messages.push('PostgreSQL: config reloaded successfully');
      } else {
        messages.push(`PostgreSQL: reload returned ${reloadCode} — ${reloadLines.join(' ')}`);
      }
    } catch (e: unknown) {
      messages.push(`PostgreSQL reload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (restartRequired) {
    messages.push('ACTION REQUIRED: postgresql.conf changed — restart PostgreSQL for listen_addresses to take effect.');
    rollbackCmds.push(
      `# Restart postgres: ${pgCtlBin} -D ${instance.dataDir ?? '<dataDir>'} restart`,
    );
  }

  // ── 5. Rollback footer ─────────────────────────────────────────────────────
  rollbackCmds.push(
    `# To reload after reverting pg_hba.conf: ${pgCtlBin} -D ${instance.dataDir ?? '<dataDir>'} reload`,
  );

  // ── Warnings ───────────────────────────────────────────────────────────────
  const ufwStatusFinal = await detectUfwStatus(instance.port);
  const warnings = generateWarnings(mode, 'same_vps', ufwStatusFinal, useTls);

  audit.record({
    category:   'database',
    action:     'apply-access-mode',
    instanceId: instance.id,
    database:   appDb,
    target:     appUser,
    ok:         true,
    meta:       { mode, cidrsCount: cidrs.length, hbaChanged, restartRequired },
  });

  return {
    ok: true,
    messages,
    hbaChanged,
    firewallResult,
    rollbackCmds,
    restartRequired,
    warnings,
  };
}

// ─── External TCP test commands ───────────────────────────────────────────────

/** Commands the user can run from their *client machine* to verify connectivity. */
export function buildExternalTestCommands(
  publicIp: string,
  port:     number,
  appUser:  string,
  appDb:    string,
): { powershell: string; linux: string; docker: string } {
  return {
    powershell: `Test-NetConnection ${publicIp} -Port ${port}`,
    linux:      `nc -vz ${publicIp} ${port}`,
    // Avoids requiring psql on the client machine.
    docker: `docker run -it --rm postgres:17 psql "postgresql://${appUser}:****@${publicIp}:${port}/${appDb}"`,
  };
}

// ─── Backup commands ──────────────────────────────────────────────────────────

export function buildBackupCommands(
  instance: Instance,
  appDb:    string,
): { manual: string; compressed: string; retention: string; restoreTest: string } {
  const h = '127.0.0.1';
  const p = instance.port;
  const u = instance.superuser;

  return {
    manual: `pg_dump -h ${h} -p ${p} -U ${u} -d ${appDb} > ${appDb}_$(date +%Y%m%d_%H%M%S).sql`,

    compressed: `pg_dump -h ${h} -p ${p} -U ${u} -d ${appDb} | gzip > ${appDb}_$(date +%Y%m%d_%H%M%S).sql.gz`,

    retention: `find /var/backups/pgmanager/${appDb} -type f -name "*.sql.gz" -mtime +7 -delete`,

    restoreTest: [
      `createdb -h ${h} -p ${p} -U ${u} ${appDb}_restore_test`,
      `gunzip -c ${appDb}_backup.sql.gz | psql -h ${h} -p ${p} -U ${u} -d ${appDb}_restore_test`,
    ].join('\n'),
  };
}

// ─── Process helpers ──────────────────────────────────────────────────────────

function spawnCollect(bin: string, args: string[], lines: string[]): Promise<number> {
  return new Promise(resolve => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: unknown) {
      lines.push(`Failed to start ${bin}: ${err instanceof Error ? err.message : String(err)}`);
      resolve(1);
      return;
    }
    proc.on('error', (e: Error) => { lines.push(`Process error: ${e.message}`); resolve(1); });
    const handle = (d: Buffer) =>
      d.toString().split(/\r?\n/).filter(Boolean).forEach(l => lines.push(l));
    proc.stdout?.on('data', handle);
    proc.stderr?.on('data', handle);
    proc.on('exit', code => resolve(code ?? 1));
  });
}

function commandExists(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    const which = process.platform === 'win32' ? 'where' : 'which';
    try {
      const p = spawn(which, [cmd], { stdio: 'ignore' });
      p.on('exit',  c => resolve(c === 0));
      p.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
