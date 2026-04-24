import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import type { Instance } from '../types';

const CONFIG_DIR  = path.join(os.homedir(), '.pgmanager');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface Config {
  instances: Instance[];
}

function ensureDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return { instances: [] };
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as Config;
  } catch {
    return { instances: [] };
  }
}

export function saveConfig(config: Config): void {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function getInstances(): Instance[] {
  return loadConfig().instances;
}

export function upsertInstance(instance: Instance): void {
  const config = loadConfig();
  const idx = config.instances.findIndex(i => i.id === instance.id);
  if (idx >= 0) {
    config.instances[idx] = instance;
  } else {
    config.instances.push(instance);
  }
  saveConfig(config);
}

export function removeInstance(id: string): void {
  const config = loadConfig();
  config.instances = config.instances.filter(i => i.id !== id);
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
