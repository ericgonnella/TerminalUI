/**
 * Append-only audit log for pgmanager.
 *
 * Events are written as JSON lines to `~/.pgmanager/audit.log` with mode 0o600.
 * This is a local security forensics trail — never a security boundary
 * (an attacker with file-system write access can obviously tamper with it).
 *
 * Design:
 * - Best-effort: write failures are swallowed so an inaccessible log never
 *   blocks a legitimate DB operation. Failures are surfaced via the returned
 *   boolean for callers that want to surface them.
 * - Redaction: only metadata is recorded — never passwords, never full SQL
 *   beyond the first 200 chars, never full connection strings.
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

const AUDIT_DIR  = path.join(os.homedir(), '.pgmanager');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');
const MAX_SQL_LENGTH = 200;

export type AuditCategory =
  | 'instance'   // create, delete, start, stop
  | 'database'   // create, drop, rename
  | 'user'       // role create, drop, password change
  | 'query'      // ad-hoc SQL execution
  | 'migration'  // migration applied
  | 'auth';      // placeholder for future login/unlock events

export interface AuditEvent {
  timestamp:  string;   // ISO 8601
  category:   AuditCategory;
  action:     string;   // short verb, e.g. 'create', 'drop', 'execute'
  instanceId?: string;
  database?:   string;
  target?:     string;  // role name, db name, migration filename, etc.
  /** Short SQL excerpt. Never includes bind values. */
  sql?:        string;
  /** Success flag — false indicates the operation was attempted and failed. */
  ok:          boolean;
  /** Optional error summary (truncated). Never includes secrets. */
  error?:      string;
  /** Extra non-sensitive metadata. */
  meta?:       Record<string, string | number | boolean>;
}

function ensureDir(): void {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\u2026' : s;
}

/** Strip anything that looks like a postgres connection URL or password
 *  clause from a string. Defensive against accidental credential leakage. */
function scrub(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, 'postgres://<redacted>')
    .replace(/\bpassword\s*[:=]\s*\S+/gi, 'password=<redacted>')
    .replace(/\bPASSWORD\s+'[^']*'/gi, "PASSWORD '<redacted>'");
}

export function record(event: Omit<AuditEvent, 'timestamp'>): boolean {
  try {
    ensureDir();
    const line: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...event,
      sql:   event.sql   ? truncate(scrub(event.sql),   MAX_SQL_LENGTH) : undefined,
      error: event.error ? truncate(scrub(event.error), 200)            : undefined,
    };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(line) + '\n', { mode: 0o600 });
    try { fs.chmodSync(AUDIT_FILE, 0o600); } catch { /* Windows or EPERM */ }
    return true;
  } catch {
    // Logging must never fail the caller.
    return false;
  }
}

/**
 * Read the most recent `limit` audit events (most recent last).
 * Returns an empty array if the log doesn't exist or is unreadable.
 */
export function tail(limit: number = 100): AuditEvent[] {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const raw = fs.readFileSync(AUDIT_FILE, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const slice = lines.slice(-limit);
    const out: AuditEvent[] = [];
    for (const l of slice) {
      try { out.push(JSON.parse(l) as AuditEvent); }
      catch { /* skip malformed lines */ }
    }
    return out;
  } catch {
    return [];
  }
}
