import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import type { Instance } from '../types';
import {
  getInstancePassword,
  setInstancePassword,
  deleteInstancePassword,
} from './vault';

const CONFIG_DIR  = path.join(os.homedir(), '.pgmanager');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface Config {
  instances: Instance[];
}

/** Restrict dir to 0o700 (owner rwx) and file to 0o600 (owner rw).
 *  Prevents other local users from reading credential metadata.
 *  No-op on Windows, where POSIX modes don't apply. */
function ensureDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } else {
    try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* Windows or EPERM */ }
  }
}

function tightenFilePermissions(file: string): void {
  try { fs.chmodSync(file, 0o600); } catch { /* Windows or EPERM */ }
}

/** Strip runtime-only secret fields before writing to disk.
 *  The plaintext `password` field MUST NEVER be persisted — it lives only
 *  in the runtime `Instance` object after being hydrated from the vault. */
function sanitizeForPersistence(instance: Instance): Instance {
  const { password, ...rest } = instance as Instance & { password?: string };
  void password;
  return rest as Instance;
}

/** Hydrate the runtime `password` field from the vault, if present. */
function hydrateFromVault(instance: Instance): Instance {
  if (!instance.hasPassword) return instance;
  const stored = getInstancePassword(instance.id);
  if (stored === undefined) return instance;
  return { ...instance, password: stored };
}

/** Reads config from disk and hydrates each instance with its vault secret. */
export function loadConfig(): Config {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return { instances: [] };
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as Config;
    const instances = parsed.instances ?? [];

    // One-shot migration: if any instance still carries a plaintext `password`
    // field on disk (from a pre-vault version), move it into the vault and
    // re-save the sanitized config. This is idempotent.
    const dirty = instances.some(
      i => typeof (i as Instance & { password?: string }).password === 'string' &&
           ((i as Instance & { password?: string }).password as string).length > 0,
    );
    if (dirty) {
      for (const i of instances) {
        const pw = (i as Instance & { password?: string }).password;
        if (typeof pw === 'string' && pw.length > 0) {
          setInstancePassword(i.id, pw);
          i.hasPassword = true;
        }
      }
      // Save without the plaintext password — sanitizeForPersistence strips it.
      fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ instances: instances.map(sanitizeForPersistence) }, null, 2),
        { encoding: 'utf-8', mode: 0o600 },
      );
      tightenFilePermissions(CONFIG_FILE);
    }

    return {
      instances: instances.map(hydrateFromVault),
    };
  } catch {
    return { instances: [] };
  }
}

/** Writes only non-secret metadata to disk. Secrets go to the vault. */
export function saveConfig(config: Config): void {
  ensureDir();
  const sanitized: Config = {
    instances: config.instances.map(sanitizeForPersistence),
  };
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(sanitized, null, 2),
    { encoding: 'utf-8', mode: 0o600 },
  );
  tightenFilePermissions(CONFIG_FILE);
}

/** Returns instances with passwords hydrated from the vault. */
export function getInstances(): Instance[] {
  return loadConfig().instances;
}

/**
 * Upsert an instance: writes metadata to config, and if the instance has a
 * runtime `password` set, stores it in the credential vault. Callers should
 * set `hasPassword: true` whenever a password is provided.
 */
export function upsertInstance(instance: Instance): void {
  const config = loadConfig();
  const idx = config.instances.findIndex(i => i.id === instance.id);
  if (idx >= 0) {
    config.instances[idx] = instance;
  } else {
    config.instances.push(instance);
  }
  // Persist the password to the vault (if supplied). An empty string means
  // "no password" — clear the vault entry rather than storing an empty secret.
  if (typeof instance.password === 'string' && instance.password.length > 0) {
    setInstancePassword(instance.id, instance.password);
  } else if (instance.hasPassword === false) {
    deleteInstancePassword(instance.id);
  }
  saveConfig(config);
}

export function removeInstance(id: string): void {
  const config = loadConfig();
  config.instances = config.instances.filter(i => i.id !== id);
  // Always scrub the vault when removing an instance to avoid stale secrets.
  deleteInstancePassword(id);
  saveConfig(config);
}

export function updateMigrationsDir(instanceId: string, dir: string): void {
  const config = loadConfig();
  const instance = config.instances.find(i => i.id === instanceId);
  if (instance) {
    instance.lastMigrationsDir = dir;
    saveConfig(config);
  }
}
