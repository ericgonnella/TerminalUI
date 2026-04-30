/**
 * remoteAccess.ts
 *
 * External / remote-access setup for PostgreSQL instances.
 *
 * Two access methods are supported:
 *
 *   1. Direct TCP — patches postgresql.conf (`listen_addresses = '*'`),
 *      writes a tagged block to pg_hba.conf with one or more CIDRs, and
 *      opens the host firewall (ufw / firewall-cmd / netsh) for the same
 *      CIDRs. Idempotent: re-running with the same CIDRs is a no-op; new
 *      CIDRs are appended.
 *
 *   2. SSH Reverse Tunnel — generates a service file on the pgmanager host
 *      (systemd / launchd / Windows Task Scheduler) that opens an outbound
 *      SSH connection to a remote VPS and binds a port there back to local
 *      PostgreSQL. The remote VPS connects to its own 127.0.0.1:<port>.
 *
 * Security rules followed:
 *   - All shell-outs use array-form spawn (no string interpolation).
 *   - All on-disk artefacts (service files, hba edits) are written 0o600 / 0o700.
 *   - CIDR / hostname inputs are validated server-side before being used.
 *   - A tagged block (`# BEGIN/END pgmanager-remote-access <id>`) lets us
 *     remove rules cleanly without touching anything we did not write.
 */

import { spawn }    from 'child_process';
import * as fs      from 'fs';
import * as os      from 'os';
import * as path    from 'path';
import type { Instance, RemoteAccessConfig, CidrEntry, SshTunnelEntry } from '../types';
import { startInstance, stopInstance, getInstanceStatus } from './pgctl';
import * as audit from './auditLog';

// ─── Common types ────────────────────────────────────────────────────────────

export interface OpResult {
  ok:               boolean;
  message:          string;
  /** True when listen_addresses had to be flipped to '*' and a full restart
   *  is required for the change to take effect (reload is not enough). */
  restartRequired: boolean;
}

const HBA_BEGIN = (id: string) => `# BEGIN pgmanager-remote-access ${id}`;
const HBA_END   = (id: string) => `# END pgmanager-remote-access ${id}`;

// ─── Validation ──────────────────────────────────────────────────────────────

const IPV4_RE = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
// Loose IPv6 validator — accepts compressed forms (::1, fe80::1) and full forms.
// We don't need to be strict here because pg_hba.conf and netsh both validate.
const IPV6_RE = /^[0-9a-fA-F:]+$/;

/**
 * Validate and normalise a CIDR. Bare IPs are auto-suffixed:
 *   "203.0.113.5"   → "203.0.113.5/32"
 *   "2001:db8::1"   → "2001:db8::1/128"
 *   "10.0.0.0/24"   → "10.0.0.0/24"
 */
export function validateCidr(input: string): { ok: boolean; value?: string; reason?: string } {
  const v = input.trim();
  if (!v) return { ok: false, reason: 'CIDR is required.' };
  if (v.length > 64) return { ok: false, reason: 'CIDR is too long.' };
  if (/[\s;|&`$<>]/.test(v)) return { ok: false, reason: 'CIDR contains invalid characters.' };

  const slash = v.indexOf('/');
  let ip: string;
  let bits: number | null;

  if (slash < 0) {
    ip = v;
    bits = null;
  } else {
    ip = v.slice(0, slash);
    const b = parseInt(v.slice(slash + 1), 10);
    if (isNaN(b)) return { ok: false, reason: 'Mask must be an integer.' };
    bits = b;
  }

  if (IPV4_RE.test(ip)) {
    if (bits === null) bits = 32;
    if (bits < 0 || bits > 32) return { ok: false, reason: 'IPv4 mask must be 0–32.' };
    return { ok: true, value: `${ip}/${bits}` };
  }
  if (ip.includes(':') && IPV6_RE.test(ip)) {
    if (bits === null) bits = 128;
    if (bits < 0 || bits > 128) return { ok: false, reason: 'IPv6 mask must be 0–128.' };
    return { ok: true, value: `${ip}/${bits}` };
  }
  return { ok: false, reason: 'Not a valid IPv4 or IPv6 address.' };
}

/** Whitelist hostname / IP for SSH tunnel target. */
export function validateSshHost(input: string): { ok: boolean; value?: string; reason?: string } {
  const v = input.trim();
  if (!v) return { ok: false, reason: 'Host is required.' };
  if (v.length > 253) return { ok: false, reason: 'Host is too long.' };
  if (/[\s@/\\?#;|&`$<>]/.test(v)) return { ok: false, reason: 'Host contains invalid characters.' };
  return { ok: true, value: v };
}

/** Whitelist SSH user. POSIX portable name set + dot/dash. */
export function validateSshUser(input: string): { ok: boolean; value?: string; reason?: string } {
  const v = input.trim();
  if (!v) return { ok: false, reason: 'User is required.' };
  if (v.length > 32) return { ok: false, reason: 'User is too long.' };
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(v)) {
    return { ok: false, reason: 'User must match [a-zA-Z_][a-zA-Z0-9_.-]*.' };
  }
  return { ok: true, value: v };
}

/** Validate a TCP port (1024–65535). */
export function validateTcpPort(raw: string): { ok: boolean; value?: number; reason?: string } {
  const t = raw.trim();
  if (!t) return { ok: false, reason: 'Port is required.' };
  if (!/^\d+$/.test(t)) return { ok: false, reason: 'Port must be a positive integer.' };
  const p = parseInt(t, 10);
  if (p < 1 || p > 65535) return { ok: false, reason: 'Port must be 1–65535.' };
  return { ok: true, value: p };
}

// ─── postgresql.conf / pg_hba.conf editors ───────────────────────────────────

/** Returns true if listen_addresses already binds on all interfaces. */
function listenAddressesIsAll(conf: string): boolean {
  const m = conf.match(/^\s*listen_addresses\s*=\s*'([^']*)'/m);
  if (!m) return false;
  const v = m[1].trim();
  return v === '*' || v === '0.0.0.0' || v.includes('*');
}

/** Set listen_addresses = '*' in postgresql.conf (idempotent). Returns whether
 *  the file was actually changed. */
function setListenAddressesAll(dataDir: string): { changed: boolean; alreadyAll: boolean } {
  const confPath = path.join(dataDir, 'postgresql.conf');
  const conf = fs.readFileSync(confPath, 'utf8');
  if (listenAddressesIsAll(conf)) {
    return { changed: false, alreadyAll: true };
  }
  let next: string;
  if (/^#?\s*listen_addresses\s*=/m.test(conf)) {
    next = conf.replace(
      /^#?\s*listen_addresses\s*=.*$/m,
      "listen_addresses = '*'    # pgmanager: remote-access",
    );
  } else {
    next = conf.endsWith('\n') ? conf : conf + '\n';
    next += "listen_addresses = '*'    # pgmanager: remote-access\n";
  }
  fs.writeFileSync(confPath, next, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(confPath, 0o600); } catch { /* Windows */ }
  return { changed: true, alreadyAll: false };
}

/** Read the current pgmanager-managed CIDR block from pg_hba.conf. */
function readManagedCidrs(dataDir: string, instanceId: string): string[] {
  const hbaPath = path.join(dataDir, 'pg_hba.conf');
  if (!fs.existsSync(hbaPath)) return [];
  const hba = fs.readFileSync(hbaPath, 'utf8');
  const begin = HBA_BEGIN(instanceId);
  const end   = HBA_END(instanceId);
  const i = hba.indexOf(begin);
  if (i < 0) return [];
  const j = hba.indexOf(end, i);
  if (j < 0) return [];
  const block = hba.slice(i + begin.length, j);
  const cidrs: string[] = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*host\s+all\s+all\s+(\S+)\s+scram-sha-256/);
    if (m) cidrs.push(m[1]);
  }
  return cidrs;
}

/** Replace (or insert) the tagged pg_hba.conf block for this instance. */
function writeHbaBlock(dataDir: string, instanceId: string, cidrs: string[]): void {
  const hbaPath = path.join(dataDir, 'pg_hba.conf');
  const hba = fs.readFileSync(hbaPath, 'utf8');
  const begin = HBA_BEGIN(instanceId);
  const end   = HBA_END(instanceId);

  const lines = cidrs.map(c => `host    all             all             ${c.padEnd(20)} scram-sha-256`);
  const block = [begin, '# Managed by pgmanager — do not edit by hand', ...lines, end, ''].join('\n');

  let next: string;
  const i = hba.indexOf(begin);
  if (i >= 0) {
    const j = hba.indexOf(end, i);
    if (j < 0) {
      // Begin without end — corrupt; append a fresh block, leave the rest.
      next = (hba.endsWith('\n') ? hba : hba + '\n') + '\n' + block;
    } else {
      const before = hba.slice(0, i);
      const after  = hba.slice(j + end.length).replace(/^\n/, '');
      next = before + block + (after.startsWith('\n') || after === '' ? after : '\n' + after);
    }
  } else {
    next = (hba.endsWith('\n') ? hba : hba + '\n') + '\n' + block;
  }

  fs.writeFileSync(hbaPath, next, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(hbaPath, 0o600); } catch { /* Windows */ }
}

/** Remove the tagged pg_hba.conf block for this instance entirely. */
function removeHbaBlock(dataDir: string, instanceId: string): boolean {
  const hbaPath = path.join(dataDir, 'pg_hba.conf');
  if (!fs.existsSync(hbaPath)) return false;
  const hba = fs.readFileSync(hbaPath, 'utf8');
  const begin = HBA_BEGIN(instanceId);
  const end   = HBA_END(instanceId);
  const i = hba.indexOf(begin);
  if (i < 0) return false;
  const j = hba.indexOf(end, i);
  if (j < 0) return false;
  const before = hba.slice(0, i);
  const after  = hba.slice(j + end.length).replace(/^\n/, '');
  fs.writeFileSync(hbaPath, before + after, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(hbaPath, 0o600); } catch { /* Windows */ }
  return true;
}

// ─── Process helpers ─────────────────────────────────────────────────────────

function spawnLines(
  bin: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise(resolve => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      onLine(`Failed to start ${bin}: ${err.message}`);
      resolve(1);
      return;
    }
    proc.on('error', e => { onLine(`Process error: ${e.message}`); resolve(1); });
    const handle = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
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

// ─── Firewall — Linux ufw / firewall-cmd, Windows netsh, macOS warn ──────────

function fwRuleName(instanceId: string, idx: number): string {
  // Stable, non-injection rule name for netsh / firewalld.
  return `pgmanager-${instanceId.slice(0, 8)}-${idx}`;
}

interface FirewallApplyResult {
  applied: string[];
  skipped: string[];
  warning: string | null;
}

async function applyFirewall(
  instance: Instance,
  cidrs: string[],
  onLine: (line: string) => void,
): Promise<FirewallApplyResult> {
  const port = instance.port;
  const applied: string[] = [];
  const skipped: string[] = [];

  if (process.platform === 'linux') {
    const hasUfw = await commandExists('ufw');
    const hasFirewallCmd = !hasUfw && await commandExists('firewall-cmd');
    if (hasUfw) {
      for (const c of cidrs) {
        onLine(`Firewall: ufw allow from ${c} to any port ${port} proto tcp`);
        const code = await spawnLines('ufw', ['allow', 'from', c, 'to', 'any', 'port', String(port), 'proto', 'tcp'], onLine);
        if (code === 0) applied.push(c); else skipped.push(c);
      }
      return { applied, skipped, warning: null };
    }
    if (hasFirewallCmd) {
      for (const c of cidrs) {
        const family = c.includes(':') ? 'ipv6' : 'ipv4';
        const rule = `rule family="${family}" source address="${c}" port port="${port}" protocol="tcp" accept`;
        onLine(`Firewall: firewall-cmd --permanent --add-rich-rule='${rule}'`);
        const code = await spawnLines('firewall-cmd', ['--permanent', `--add-rich-rule=${rule}`], onLine);
        if (code === 0) applied.push(c); else skipped.push(c);
      }
      const reload = await spawnLines('firewall-cmd', ['--reload'], onLine);
      if (reload !== 0) onLine('Firewall: firewall-cmd reload returned non-zero');
      return { applied, skipped, warning: null };
    }
    return {
      applied, skipped,
      warning: `No supported firewall tool found (ufw / firewall-cmd). Open port ${port}/tcp for the listed CIDRs manually.`,
    };
  }

  if (process.platform === 'win32') {
    let i = 0;
    for (const c of cidrs) {
      // Windows firewall accepts CIDR for IPv4. IPv6 CIDR support is patchy —
      // we try anyway; on failure we warn the user that the pg_hba.conf rule
      // is still in effect but no host firewall rule was added.
      const ruleName = fwRuleName(instance.id, i++);
      onLine(`Firewall: netsh advfirewall firewall add rule name=${ruleName} ...`);
      const code = await spawnLines('netsh', [
        'advfirewall', 'firewall', 'add', 'rule',
        `name=${ruleName}`,
        'dir=in', 'action=allow', 'protocol=TCP',
        `localport=${port}`,
        `remoteip=${c}`,
      ], onLine);
      if (code === 0) applied.push(c); else skipped.push(c);
    }
    return { applied, skipped, warning: null };
  }

  if (process.platform === 'darwin') {
    return {
      applied: [], skipped: cidrs,
      warning: `macOS pf firewall is not auto-configured. pg_hba.conf has been updated; if your Mac firewall is on, manually add an inbound rule for TCP/${port} from the listed CIDRs.`,
    };
  }

  return {
    applied: [], skipped: cidrs,
    warning: `Unsupported platform (${process.platform}) for automated firewall — open port ${port}/tcp manually.`,
  };
}

async function revokeFirewall(
  instance: Instance,
  cidrs: string[],
  onLine: (line: string) => void,
): Promise<void> {
  const port = instance.port;

  if (process.platform === 'linux') {
    if (await commandExists('ufw')) {
      for (const c of cidrs) {
        onLine(`Firewall: ufw delete allow from ${c} to any port ${port} proto tcp`);
        await spawnLines('ufw', ['delete', 'allow', 'from', c, 'to', 'any', 'port', String(port), 'proto', 'tcp'], onLine);
      }
      return;
    }
    if (await commandExists('firewall-cmd')) {
      for (const c of cidrs) {
        const family = c.includes(':') ? 'ipv6' : 'ipv4';
        const rule = `rule family="${family}" source address="${c}" port port="${port}" protocol="tcp" accept`;
        await spawnLines('firewall-cmd', ['--permanent', `--remove-rich-rule=${rule}`], onLine);
      }
      await spawnLines('firewall-cmd', ['--reload'], onLine);
      return;
    }
    return;
  }

  if (process.platform === 'win32') {
    // We don't track each rule's index in config (only the CIDR list), so we
    // delete by name prefix. netsh supports `name=<exact>` — we walk indices
    // up to a reasonable bound based on the current count.
    for (let i = 0; i < Math.max(cidrs.length, 32); i++) {
      const name = fwRuleName(instance.id, i);
      await spawnLines('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`], onLine);
    }
    return;
  }
  // macOS: nothing to do.
}

// ─── pg_ctl reload (delegates to the same binary as pgctl.ts) ────────────────

/** Tells a running PostgreSQL server to re-read its config files. No restart. */
async function pgCtlReload(
  pgCtlBin: string,
  instance: Instance,
  onLine: (line: string) => void,
): Promise<{ ok: boolean }> {
  if (!pgCtlBin) {
    onLine('pg_ctl reload: pg_ctl binary not available — skipping (changes apply on next start).');
    return { ok: false };
  }
  const code = await spawnLines(pgCtlBin, ['reload', '-D', instance.dataDir], onLine);
  return { ok: code === 0 };
}

// ─── Public API: Direct TCP ──────────────────────────────────────────────────

export interface ApplyDirectOptions {
  /** New CIDRs to add (will be merged with whatever is already configured). */
  cidrs:     string[];
  pgCtlBin:  string;
  /** If the instance is running and a restart is needed (listen_addresses was
   *  flipped to '*'), should we restart automatically? */
  autoRestart: boolean;
}

export interface ApplyDirectResult extends OpResult {
  /** Final list of CIDRs configured for this instance, including pre-existing. */
  effectiveCidrs:  string[];
  firewallApplied: string[];
  firewallSkipped: string[];
  firewallWarning: string | null;
  /** True if the instance was restarted as part of this call. */
  restarted:       boolean;
}

export async function applyDirectAccess(
  instance: Instance,
  opts: ApplyDirectOptions,
  onLine: (line: string) => void,
): Promise<ApplyDirectResult> {
  // 1) Validate CIDRs.
  const normalised: string[] = [];
  for (const raw of opts.cidrs) {
    const v = validateCidr(raw);
    if (!v.ok || !v.value) {
      audit.record({ category: 'instance', action: 'remote-access:apply-direct', instanceId: instance.id, ok: false, error: v.reason ?? 'invalid CIDR' });
      return {
        ok: false, message: `Invalid CIDR "${raw}": ${v.reason}`,
        restartRequired: false, effectiveCidrs: [], firewallApplied: [], firewallSkipped: [],
        firewallWarning: null, restarted: false,
      };
    }
    normalised.push(v.value);
  }

  // 2) Merge with existing managed CIDRs (idempotent re-runs are safe).
  const existing = readManagedCidrs(instance.dataDir, instance.id);
  const merged   = Array.from(new Set([...existing, ...normalised]));

  // 3) Update postgresql.conf if needed.
  let listenChanged = false;
  let alreadyAll    = false;
  try {
    const r = setListenAddressesAll(instance.dataDir);
    listenChanged = r.changed;
    alreadyAll    = r.alreadyAll;
    onLine(listenChanged
      ? "postgresql.conf: listen_addresses set to '*'"
      : 'postgresql.conf: listen_addresses already permits remote connections');
  } catch (err: any) {
    audit.record({ category: 'instance', action: 'remote-access:apply-direct', instanceId: instance.id, ok: false, error: String(err?.message ?? err) });
    return {
      ok: false, message: `postgresql.conf update failed: ${String(err?.message ?? err)}`,
      restartRequired: false, effectiveCidrs: existing, firewallApplied: [], firewallSkipped: [],
      firewallWarning: null, restarted: false,
    };
  }

  // 4) Write pg_hba.conf block.
  try {
    writeHbaBlock(instance.dataDir, instance.id, merged);
    onLine(`pg_hba.conf: managed block written with ${merged.length} CIDR(s)`);
  } catch (err: any) {
    audit.record({ category: 'instance', action: 'remote-access:apply-direct', instanceId: instance.id, ok: false, error: String(err?.message ?? err) });
    return {
      ok: false, message: `pg_hba.conf update failed: ${String(err?.message ?? err)}`,
      restartRequired: false, effectiveCidrs: existing, firewallApplied: [], firewallSkipped: [],
      firewallWarning: null, restarted: false,
    };
  }

  // 5) Apply firewall.
  const fw = await applyFirewall(instance, normalised, onLine);
  if (fw.warning) onLine(`Firewall: ${fw.warning}`);

  // 6) Reload or restart PostgreSQL.
  const status = await getInstanceStatus(opts.pgCtlBin, instance);
  const running = status === 'running';
  const restartRequired = listenChanged && running;
  let restarted = false;

  if (running && !restartRequired) {
    await pgCtlReload(opts.pgCtlBin, instance, onLine);
  } else if (restartRequired && opts.autoRestart) {
    onLine('Restarting PostgreSQL to apply listen_addresses change...');
    const stop = await stopInstance(opts.pgCtlBin, instance, onLine);
    if (!stop.ok) {
      audit.record({ category: 'instance', action: 'remote-access:apply-direct', instanceId: instance.id, ok: false, error: 'restart-stop-failed' });
      return {
        ok: false, message: `Failed to stop PostgreSQL: ${stop.output}`,
        restartRequired: true, effectiveCidrs: merged, firewallApplied: fw.applied,
        firewallSkipped: fw.skipped, firewallWarning: fw.warning, restarted: false,
      };
    }
    const start = await startInstance(opts.pgCtlBin, instance, onLine);
    if (!start.ok) {
      audit.record({ category: 'instance', action: 'remote-access:apply-direct', instanceId: instance.id, ok: false, error: 'restart-start-failed' });
      return {
        ok: false, message: `Failed to restart PostgreSQL: ${start.output}`,
        restartRequired: true, effectiveCidrs: merged, firewallApplied: fw.applied,
        firewallSkipped: fw.skipped, firewallWarning: fw.warning, restarted: false,
      };
    }
    restarted = true;
  }

  audit.record({
    category: 'instance', action: 'remote-access:apply-direct', instanceId: instance.id, ok: true,
    meta: { cidrCount: merged.length, listenChanged, restarted, alreadyAll },
  });

  return {
    ok: true,
    message: `Configured ${merged.length} CIDR(s).`,
    restartRequired: restartRequired && !restarted,
    effectiveCidrs:  merged,
    firewallApplied: fw.applied,
    firewallSkipped: fw.skipped,
    firewallWarning: fw.warning,
    restarted,
  };
}

export async function revokeDirectAccess(
  instance: Instance,
  pgCtlBin: string,
  onLine: (line: string) => void,
): Promise<OpResult> {
  const cidrs = readManagedCidrs(instance.dataDir, instance.id);
  try {
    const removed = removeHbaBlock(instance.dataDir, instance.id);
    onLine(removed
      ? 'pg_hba.conf: managed block removed'
      : 'pg_hba.conf: no managed block found (already revoked)');
  } catch (err: any) {
    audit.record({ category: 'instance', action: 'remote-access:revoke-direct', instanceId: instance.id, ok: false, error: String(err?.message ?? err) });
    return { ok: false, message: `pg_hba.conf update failed: ${String(err?.message ?? err)}`, restartRequired: false };
  }

  await revokeFirewall(instance, cidrs, onLine);

  const status = await getInstanceStatus(pgCtlBin, instance);
  if (status === 'running') {
    await pgCtlReload(pgCtlBin, instance, onLine);
  }

  audit.record({
    category: 'instance', action: 'remote-access:revoke-direct', instanceId: instance.id, ok: true,
    meta: { cidrCount: cidrs.length },
  });

  return { ok: true, message: `Revoked ${cidrs.length} CIDR rule(s).`, restartRequired: false };
}

// ─── Public API: SSH Reverse Tunnel ──────────────────────────────────────────

export interface SshTunnelOptions {
  /** Reachable hostname/IP of the remote VPS. */
  remoteHost: string;
  /** SSH user on the remote VPS. */
  sshUser:    string;
  /** SSH port on the remote VPS (default 22). */
  sshPort:    number;
  /** Port to bind on the remote VPS (will forward to local PG). */
  remotePort: number;
}

export interface GeneratedTunnel {
  /** Path written on disk. */
  filePath:           string;
  /** A name useful for systemd unit / Windows scheduled task identification. */
  serviceName:        string;
  /** Per-platform install instructions. */
  installInstructions: string[];
  /** Connection string the remote machine will use after the tunnel is up. */
  remoteConnectionUrl: string;
}

function tunnelDir(): string {
  const dir = path.join(os.homedir(), '.pgmanager', 'services');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  else { try { fs.chmodSync(dir, 0o700); } catch { /* Windows */ } }
  return dir;
}

function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

export function generateAndSaveSshTunnel(
  instance: Instance,
  opts: SshTunnelOptions,
): GeneratedTunnel {
  const dir = tunnelDir();
  const safeName    = safeFileName(instance.name);
  const serviceName = `pgmanager-tunnel-${safeName}-${instance.port}`;

  // Common SSH args (used by both bash and bat versions):
  // -N: no remote command
  // -T: no TTY
  // -o ServerAliveInterval=30: keepalive
  // -o ExitOnForwardFailure=yes: exit cleanly if the forward can't be set up
  // -R <remotePort>:127.0.0.1:<localPort>: reverse forward
  const remoteSpec = `${opts.remotePort}:127.0.0.1:${instance.port}`;

  const remoteConnectionUrl =
    `postgresql://<app-user>:<app-password>@127.0.0.1:${opts.remotePort}/<app-db>`;

  if (process.platform === 'linux') {
    const filePath = path.join(dir, `${serviceName}.service`);
    const user = os.userInfo().username;
    const content = [
      '[Unit]',
      `Description=pgmanager SSH reverse tunnel — ${instance.name}`,
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      `User=${user}`,
      'Type=simple',
      'Restart=always',
      'RestartSec=10',
      `ExecStart=/usr/bin/ssh -NT -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ` +
        `-o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new ` +
        `-p ${opts.sshPort} -R ${remoteSpec} ${opts.sshUser}@${opts.remoteHost}`,
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch {}
    return {
      filePath, serviceName,
      installInstructions: [
        `1. Make sure SSH key auth works:  ssh -p ${opts.sshPort} ${opts.sshUser}@${opts.remoteHost} echo ok`,
        `2. Install the unit:              sudo cp "${filePath}" /etc/systemd/system/${serviceName}.service`,
        `3. Enable + start:                sudo systemctl daemon-reload && sudo systemctl enable --now ${serviceName}`,
        `4. Check status:                  systemctl status ${serviceName}`,
        `5. On the remote machine, also add to /etc/ssh/sshd_config:  GatewayPorts no   (default — keeps the bound port on 127.0.0.1)`,
      ],
      remoteConnectionUrl,
    };
  }

  if (process.platform === 'darwin') {
    const filePath = path.join(dir, `com.pgmanager.${safeName}.${instance.port}.plist`);
    const content =
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pgmanager.${safeName}.${instance.port}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-NT</string>
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>StrictHostKeyChecking=accept-new</string>
    <string>-p</string><string>${opts.sshPort}</string>
    <string>-R</string><string>${remoteSpec}</string>
    <string>${opts.sshUser}@${opts.remoteHost}</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch {}
    return {
      filePath, serviceName: `com.pgmanager.${safeName}.${instance.port}`,
      installInstructions: [
        `1. Verify SSH:    ssh -p ${opts.sshPort} ${opts.sshUser}@${opts.remoteHost} echo ok`,
        `2. Install:       cp "${filePath}" ~/Library/LaunchAgents/`,
        `3. Load:          launchctl load -w ~/Library/LaunchAgents/com.pgmanager.${safeName}.${instance.port}.plist`,
        `4. Check:         launchctl list | grep pgmanager`,
      ],
      remoteConnectionUrl,
    };
  }

  // Windows — generate a .bat that loops ssh, plus a Task Scheduler XML.
  const batPath = path.join(dir, `${serviceName}.bat`);
  const xmlPath = path.join(dir, `${serviceName}.xml`);
  const bat = [
    '@echo off',
    `:loop`,
    `ssh -NT -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes ` +
      `-o StrictHostKeyChecking=accept-new -p ${opts.sshPort} -R ${remoteSpec} ${opts.sshUser}@${opts.remoteHost}`,
    `timeout /t 10 /nobreak >nul`,
    `goto loop`,
    '',
  ].join('\r\n');
  fs.writeFileSync(batPath, bat, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(batPath, 0o600); } catch {}

  const xml =
`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>pgmanager SSH reverse tunnel for ${instance.name}</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger><Enabled>true</Enabled></BootTrigger>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>9999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${batPath}</Command>
    </Exec>
  </Actions>
</Task>
`;
  fs.writeFileSync(xmlPath, xml, { encoding: 'utf16le', mode: 0o600 });
  try { fs.chmodSync(xmlPath, 0o600); } catch {}

  return {
    filePath: batPath, serviceName,
    installInstructions: [
      `1. Verify SSH:        ssh -p ${opts.sshPort} ${opts.sshUser}@${opts.remoteHost} echo ok`,
      `2. Register the task: schtasks /Create /TN "${serviceName}" /XML "${xmlPath}"`,
      `3. Start it now:      schtasks /Run    /TN "${serviceName}"`,
      `4. Check status:      schtasks /Query  /TN "${serviceName}"`,
    ],
    remoteConnectionUrl,
  };
}

export function deleteSshTunnelFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    // Best-effort: also remove sibling Windows XML if present.
    if (filePath.endsWith('.bat')) {
      const xml = filePath.replace(/\.bat$/, '.xml');
      if (fs.existsSync(xml)) fs.unlinkSync(xml);
    }
  } catch { /* best-effort */ }
}

// ─── Helpers used by the screen ──────────────────────────────────────────────

/** Build a fresh RemoteAccessConfig from the previous one + the latest direct apply. */
export function withDirectApplied(
  prev: RemoteAccessConfig | undefined,
  cidrs: string[],
  listenAllUpdated: boolean,
): RemoteAccessConfig {
  const now = new Date().toISOString();
  const map = new Map<string, CidrEntry>();
  for (const e of prev?.directCidrs ?? []) map.set(e.cidr, e);
  for (const c of cidrs) if (!map.has(c)) map.set(c, { cidr: c, addedAt: now });
  return {
    directCidrs:      Array.from(map.values()),
    sshTunnels:       prev?.sshTunnels ?? [],
    listenAllUpdated: listenAllUpdated || (prev?.listenAllUpdated ?? false),
    lastUpdatedAt:    now,
  };
}

export function withDirectRevoked(prev: RemoteAccessConfig | undefined): RemoteAccessConfig {
  return {
    directCidrs:      [],
    sshTunnels:       prev?.sshTunnels ?? [],
    listenAllUpdated: prev?.listenAllUpdated ?? false,
    lastUpdatedAt:    new Date().toISOString(),
  };
}

export function withTunnelAdded(
  prev: RemoteAccessConfig | undefined,
  entry: SshTunnelEntry,
): RemoteAccessConfig {
  return {
    directCidrs:      prev?.directCidrs ?? [],
    sshTunnels:       [...(prev?.sshTunnels ?? []), entry],
    listenAllUpdated: prev?.listenAllUpdated ?? false,
    lastUpdatedAt:    new Date().toISOString(),
  };
}

export function withAllTunnelsRevoked(prev: RemoteAccessConfig | undefined): RemoteAccessConfig {
  // Caller is responsible for deleting the on-disk service files.
  return {
    directCidrs:      prev?.directCidrs ?? [],
    sshTunnels:       [],
    listenAllUpdated: prev?.listenAllUpdated ?? false,
    lastUpdatedAt:    new Date().toISOString(),
  };
}

