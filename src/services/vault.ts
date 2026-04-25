/**
 * Credential vault for pgmanager.
 *
 * Stores per-instance secrets (e.g. superuser passwords) in an AES-256-GCM
 * encrypted file at `~/.pgmanager/vault.enc`, mode 0o600.
 *
 * Design decisions
 * ----------------
 * - No native dependencies (no keytar / libsecret). Works on every platform
 *   including headless servers without a keychain daemon.
 * - Key derivation uses PBKDF2-SHA256 (600k iterations) over a machine-bound
 *   salt stored in `~/.pgmanager/.vault-salt` (32 random bytes, mode 0o600).
 *   The salt is mixed with `os.hostname()` + `os.userInfo().username` so the
 *   derived key is tied to the specific user+machine the vault was created on.
 * - Threat model: protects credentials from casual inspection of config.json
 *   and from users on the same machine who cannot read files in a 0o700 dir.
 *   It is NOT a replacement for full-disk encryption or an HSM — an attacker
 *   with code execution as the same OS user can always decrypt the vault.
 *
 * Future work: optional user-supplied passphrase (lock/unlock) layered on top.
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  randomBytes,
  pbkdf2Sync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'crypto';

const VAULT_DIR  = path.join(os.homedir(), '.pgmanager');
const VAULT_FILE = path.join(VAULT_DIR, 'vault.enc');
const SALT_FILE  = path.join(VAULT_DIR, '.vault-salt');

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH        = 32;      // AES-256
const IV_LENGTH         = 12;      // GCM standard
const AUTH_TAG_LENGTH   = 16;
const SALT_LENGTH       = 32;
const FORMAT_VERSION    = 1;       // bump if we change key derivation or cipher

interface VaultData {
  secrets: Record<string, string>;
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  } else {
    try { fs.chmodSync(VAULT_DIR, 0o700); } catch { /* Windows or EPERM */ }
  }
}

function tightenPermissions(file: string): void {
  try { fs.chmodSync(file, 0o600); } catch { /* Windows or EPERM */ }
}

function writeSecureFile(file: string, data: Buffer | string): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  tightenPermissions(file);
}

// ─── Key derivation ───────────────────────────────────────────────────────────

function loadOrCreateSalt(): Buffer {
  ensureDir();
  if (fs.existsSync(SALT_FILE)) {
    const existing = fs.readFileSync(SALT_FILE);
    if (existing.length === SALT_LENGTH) return existing;
    // Corrupt or wrong-size salt — regenerate. Any existing vault will become
    // unreadable, which is the correct failure mode.
  }
  const salt = randomBytes(SALT_LENGTH);
  writeSecureFile(SALT_FILE, salt);
  return salt;
}

function deriveKey(salt: Buffer): Buffer {
  // Bind the key to the current user+host. An attacker who steals the vault
  // file alone (without the salt or the matching user/host context) cannot
  // decrypt it. This is defense-in-depth; the primary protection is the
  // 0o600 file mode.
  const passphrase =
    `pgmanager:${os.hostname()}:${os.userInfo().username}`;
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

// ─── Encryption / decryption ──────────────────────────────────────────────────

/** File layout: [1B version][32B salt][12B iv][16B tag][N bytes ciphertext] */
function encrypt(plaintext: string, key: Buffer, salt: Buffer): Buffer {
  const iv     = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct     = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    salt,
    iv,
    tag,
    ct,
  ]);
}

function decrypt(blob: Buffer, key: Buffer): string {
  if (blob.length < 1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Vault file is corrupt or truncated');
  }
  const version = blob[0];
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported vault format version: ${version}`);
  }
  let offset = 1 + SALT_LENGTH; // salt is validated by caller (see decryptVault)
  const iv  = blob.subarray(offset, offset + IV_LENGTH);      offset += IV_LENGTH;
  const tag = blob.subarray(offset, offset + AUTH_TAG_LENGTH); offset += AUTH_TAG_LENGTH;
  const ct  = blob.subarray(offset);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// ─── Vault I/O ────────────────────────────────────────────────────────────────

function loadVault(): VaultData {
  ensureDir();
  if (!fs.existsSync(VAULT_FILE)) return { secrets: {} };

  const blob = fs.readFileSync(VAULT_FILE);
  if (blob.length < 1 + SALT_LENGTH) return { secrets: {} };

  // Verify the salt stored in the vault matches our side-file. If they diverge
  // (e.g. user restored one file but not the other), refuse to decrypt rather
  // than silently producing garbage.
  const embeddedSalt = blob.subarray(1, 1 + SALT_LENGTH);
  const diskSalt     = loadOrCreateSalt();
  if (embeddedSalt.length !== diskSalt.length ||
      !timingSafeEqual(embeddedSalt, diskSalt)) {
    throw new Error(
      'Vault salt mismatch — the vault file and salt file are out of sync. ' +
      'If you restored from a backup, restore both files together.'
    );
  }

  const key = deriveKey(diskSalt);
  try {
    const json = decrypt(blob, key);
    const parsed = JSON.parse(json) as VaultData;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.secrets !== 'object') {
      return { secrets: {} };
    }
    return parsed;
  } catch (err: any) {
    // Most likely: wrong key (hostname/username changed), corrupt file, or
    // the file was tampered with (GCM tag mismatch). We surface this rather
    // than silently discarding the user's stored credentials.
    throw new Error(
      `Cannot decrypt vault: ${err.message}. ` +
      'If you changed usernames or hostnames, you will need to re-enter your credentials.'
    );
  }
}

function saveVault(data: VaultData): void {
  ensureDir();
  const salt = loadOrCreateSalt();
  const key  = deriveKey(salt);
  const blob = encrypt(JSON.stringify(data), key, salt);
  writeSecureFile(VAULT_FILE, blob);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Retrieve a secret by key, or undefined if not present. */
export function getSecret(key: string): string | undefined {
  try {
    const data = loadVault();
    return data.secrets[key];
  } catch {
    // Decrypt failure — treat as missing so callers can prompt for re-entry.
    // The underlying error is intentionally swallowed here because callers
    // generally cannot recover; the user sees a "no password on file" path.
    return undefined;
  }
}

/** Store or replace a secret under `key`. */
export function setSecret(key: string, value: string): void {
  const data = (() => {
    try { return loadVault(); }
    catch { return { secrets: {} } as VaultData; } // rebuild on decrypt failure
  })();
  data.secrets[key] = value;
  saveVault(data);
}

/** Remove a secret. No-op if the key doesn't exist. */
export function deleteSecret(key: string): void {
  let data: VaultData;
  try { data = loadVault(); }
  catch { return; }
  if (!(key in data.secrets)) return;
  delete data.secrets[key];
  saveVault(data);
}

/** List all secret keys currently stored in the vault. */
export function listSecretKeys(): string[] {
  try {
    return Object.keys(loadVault().secrets);
  } catch {
    return [];
  }
}

// ─── Instance-specific convenience helpers ────────────────────────────────────

function instanceKey(id: string): string {
  return `instance:${id}:password`;
}

export function getInstancePassword(instanceId: string): string | undefined {
  return getSecret(instanceKey(instanceId));
}

export function setInstancePassword(instanceId: string, password: string): void {
  setSecret(instanceKey(instanceId), password);
}

export function deleteInstancePassword(instanceId: string): void {
  deleteSecret(instanceKey(instanceId));
}
