/**
 * Shared password policy used by instance creation / import flows.
 *
 * Design:
 * - Hosted instances (production/server) require strong passwords since they
 *   may be network-reachable.
 * - Local instances (personal machine) enforce a weaker baseline to reduce
 *   friction, but still reject trivially-short values.
 * - Empty passwords are allowed ONLY on local instances and are mapped to
 *   `--auth=trust` by `initdb`.
 */

import type { InstallationType } from '../types';

export interface PasswordPolicyResult {
  ok: boolean;
  /** Null when ok; a short user-facing reason when not. */
  reason: string | null;
}

const LOCAL_MIN_LENGTH  = 8;
const HOSTED_MIN_LENGTH = 12;

export function validatePassword(
  password:  string,
  placement: InstallationType,
): PasswordPolicyResult {
  if (password.length === 0) {
    if (placement === 'hosted') {
      return { ok: false, reason: 'Hosted instances require a password — trust auth is not safe on a networked host.' };
    }
    return { ok: true, reason: null }; // trust auth for local
  }

  const minLength = placement === 'hosted' ? HOSTED_MIN_LENGTH : LOCAL_MIN_LENGTH;
  if (password.length < minLength) {
    return {
      ok: false,
      reason: `Password must be at least ${minLength} characters for ${placement} instances.`,
    };
  }

  if (placement === 'hosted') {
    // Require at least three of: lowercase, uppercase, digit, symbol.
    const classes =
      (/[a-z]/.test(password) ? 1 : 0) +
      (/[A-Z]/.test(password) ? 1 : 0) +
      (/[0-9]/.test(password) ? 1 : 0) +
      (/[^A-Za-z0-9]/.test(password) ? 1 : 0);
    if (classes < 3) {
      return {
        ok: false,
        reason: 'Hosted passwords must use at least 3 of: lowercase, uppercase, digit, symbol.',
      };
    }
  }

  return { ok: true, reason: null };
}

/**
 * Validate a TCP port value entered by the user. Rejects non-numeric,
 * out-of-range, and privileged (< 1024) ports.
 */
export function validatePort(raw: string): { ok: boolean; value: number; reason: string | null } {
  const p = parseInt(raw.trim(), 10);
  if (isNaN(p) || p < 1 || p > 65535) {
    return { ok: false, value: 0, reason: 'Port must be a number between 1 and 65535.' };
  }
  if (p < 1024) {
    return { ok: false, value: p, reason: 'Ports below 1024 require admin/root privileges. Pick 1024 or higher.' };
  }
  return { ok: true, value: p, reason: null };
}

/**
 * Validate a hostname / IP. We keep this intentionally permissive (since PG
 * users may target weird DNS names), but we reject obvious garbage and strings
 * that would produce a malformed connection string.
 */
export function validateHost(raw: string): { ok: boolean; value: string; reason: string | null } {
  const h = raw.trim();
  if (h.length === 0) return { ok: true, value: '127.0.0.1', reason: null };
  if (h.length > 253) return { ok: false, value: h, reason: 'Host is too long (max 253 chars).' };
  // Reject whitespace, control chars, and characters that break URIs.
  if (/[\s@/\\?#]/.test(h)) {
    return { ok: false, value: h, reason: 'Host contains invalid characters (spaces, @, /, ?, #).' };
  }
  return { ok: true, value: h, reason: null };
}
