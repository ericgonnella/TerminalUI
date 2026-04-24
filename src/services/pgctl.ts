import { spawn }    from 'child_process';
import * as net     from 'net';
import * as fs      from 'fs';
import * as os      from 'os';
import * as path    from 'path';
import type { Instance, InstanceStatus } from '../types';

// ─── Windows service helpers ──────────────────────────────────────────────────

/** Start or stop a named Windows service via `net start/stop`. */
async function windowsServiceAction(
  serviceName: string,
  action:      'start' | 'stop',
  onLine?:     (line: string) => void,
): Promise<PgCtlResult> {
  const lines: string[] = [];
  const collector = (l: string) => { lines.push(l); onLine?.(l); };
  const code = await spawnLines('net', [action, serviceName], collector);
  return { ok: code === 0, output: lines.join('\n') };
}

/** Start/stop a Linux systemd unit. Requires the user to have sudo/polkit rights. */
async function systemdServiceAction(
  serviceName: string,
  action:      'start' | 'stop',
  onLine?:     (line: string) => void,
): Promise<PgCtlResult> {
  const lines: string[] = [];
  const collector = (l: string) => { lines.push(l); onLine?.(l); };
  // Use array args — never shell interpolation — to avoid injection.
  const code = await spawnLines('systemctl', [action, serviceName], collector);
  if (code !== 0) {
    const hint = 'systemctl requires sudo/polkit. Try: sudo systemctl ' + action + ' ' + serviceName;
    lines.push(hint);
    onLine?.(hint);
  }
  return { ok: code === 0, output: lines.join('\n') };
}

/** Query systemd unit state: returns 'running' if active, 'stopped' if inactive/failed, 'unknown' otherwise. */
async function systemdServiceStatus(serviceName: string): Promise<InstanceStatus> {
  return new Promise(resolve => {
    let settled = false;
    const done = (s: InstanceStatus) => { if (!settled) { settled = true; resolve(s); } };
    try {
      const proc = spawn('systemctl', ['is-active', serviceName], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('error', () => done('error'));
      proc.on('exit', () => {
        const t = out.trim();
        if (t === 'active')    return done('running');
        if (t === 'inactive' || t === 'failed') return done('stopped');
        done('unknown');
      });
    } catch { done('error'); }
  });
}

/** TCP probe: returns true if something is accepting connections on host:port. */
function isTcpPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const sock  = new net.Socket();
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 2000);
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once('error',   () => { clearTimeout(timer); resolve(false); });
    sock.connect(port, host);
  });
}

/**
 * Read the last `maxLines` non-empty lines of a file. Returns '' if the file
 * does not exist, is empty, or cannot be read. Used to surface postgres's
 * own startup log when `pg_ctl start` fails with the uninformative
 * "Examine the log output" message.
 */
export function readLogTail(filePath: string, maxLines: number = 40): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    const text  = fs.readFileSync(filePath, { encoding: 'utf8' });
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return '';
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

export interface PgCtlResult {
  ok:     boolean;
  output: string;
}

interface SpawnOpts {
  /** Working directory. On Windows we use the PG bin dir so DLLs resolve. */
  cwd?:    string;
  /** Extra directories to prepend to PATH for DLL/search resolution. */
  extraPath?: string[];
}

function buildChildEnv(extraPath: string[] = []): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':';
  const existing = process.env.PATH ?? '';
  const prefix = extraPath.filter(Boolean).join(sep);
  return { ...process.env, PATH: prefix ? `${prefix}${sep}${existing}` : existing };
}

/** Stream lines from a spawned process, calling onLine for each, returns exit code */
function spawnLines(
  bin:    string,
  args:   string[],
  onLine: (line: string) => void,
  opts:   SpawnOpts = {},
): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: number) => { if (!settled) { settled = true; resolve(code); } };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd:   opts.cwd,
        env:   buildChildEnv(opts.extraPath),
      });
    } catch (err: any) {
      onLine(`Failed to start process: ${err.message}`);
      done(1);
      return;
    }

    proc.on('error', (err) => {
      onLine(`Process error: ${err.message}`);
      done(1);
    });

    const handle = (data: Buffer) => {
      data.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
    };
    proc.stdout?.on('data', handle);
    proc.stderr?.on('data', handle);
    // Use 'exit' not 'close' — `pg_ctl start` forks the server process which
    // inherits stdout/stderr and keeps those pipes open even after pg_ctl
    // itself has exited, so 'close' would never fire on Windows.
    proc.on('exit', (code) => {
      // Unref pipes so Node doesn't wait on the server's inherited handles.
      try { proc.stdout?.destroy(); } catch { /* ignore */ }
      try { proc.stderr?.destroy(); } catch { /* ignore */ }
      done(code ?? 1);
    });
  });
}

/** Run a pg_ctl/initdb command and collect output */
async function pgCtlRun(
  pgCtlBin: string,
  args:     string[],
  onLine?:  (line: string) => void,
  opts?:    SpawnOpts,
): Promise<PgCtlResult> {
  const lines: string[] = [];
  const collector = (l: string) => { lines.push(l); onLine?.(l); };
  const code = await spawnLines(pgCtlBin, args, collector, opts);
  if (code !== 0 && lines.length === 0) {
    const isDllError = code === 3221225781 || code === -1073741515;
    const msg = `Process exited with code ${code} (0x${(code >>> 0).toString(16).toUpperCase()}) — no output captured`
      + (isDllError
          ? '\n\n[STATUS_DLL_NOT_FOUND] One or more required DLLs are missing from your PostgreSQL installation (commonly libpq, libssl, libcrypto, libintl, libiconv, or the ICU 74 libraries).'
            + '\n\nQuickest fix: press [G] from the pgmanager Home screen to download a self-contained portable PostgreSQL version — all DLLs are included, no system install needed.'
            + '\n\nAlternative: reinstall PostgreSQL from https://www.postgresql.org/download/windows/ (EDB installer).'
          : '');
    lines.push(msg);
    onLine?.(msg);
  }
  return { ok: code === 0, output: lines.join('\n') };
}

/** Windows DLL search dirs for a given PG binary: its own bin dir, plus
 *  any sibling `lib` and the pgAdmin 4 runtime which ships libpq.dll. */
function windowsDllDirs(bin: string): string[] {
  if (process.platform !== 'win32') return [];
  const binDir  = path.dirname(bin);
  const pgRoot  = path.dirname(binDir);
  const dirs = [
    binDir,
    path.join(pgRoot, 'lib'),
    path.join(pgRoot, 'pgAdmin 4', 'runtime'),
  ];
  return dirs.filter(d => fs.existsSync(d));
}

/**
 * Initialise a new PostgreSQL data directory.
 * If `password` is provided, scram-sha-256 auth is used; otherwise trust auth.
 */
export async function initDb(
  initdbBin: string,
  dataDir:   string,
  superuser: string,
  onLine?:   (line: string) => void,
  password?: string,
): Promise<PgCtlResult> {
  // Pre-flight: binary must exist
  if (!fs.existsSync(initdbBin)) {
    const msg = `initdb binary not found: ${initdbBin}`;
    onLine?.(msg);
    return { ok: false, output: msg };
  }

  // Pre-flight: data directory must not already exist
  if (fs.existsSync(dataDir)) {
    const msg = `Data directory already exists: ${dataDir}  (delete it first or choose a different path)`;
    onLine?.(msg);
    return { ok: false, output: msg };
  }

  // Pre-flight: parent directory must be writable
  const parentDir = path.dirname(dataDir);
  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch (err: any) {
    const msg = `Cannot create parent directory ${parentDir}: ${err.message}`;
    onLine?.(msg);
    return { ok: false, output: msg };
  }

  const binDir    = path.dirname(initdbBin);
  const extraPath = windowsDllDirs(initdbBin);

  // Health preflight: make sure initdb can even load its DLLs.
  onLine?.(`Checking initdb is runnable...`);
  const health = await pgCtlRun(initdbBin, ['--version'], undefined, { cwd: binDir, extraPath });
  if (!health.ok) {
    onLine?.(`Pre-flight failed: ${health.output}`);
    return { ok: false, output: `Cannot run initdb:\n${health.output}` };
  }

  // Build args. If a password was supplied, write it to a temp file and use
  // --pwfile + scram-sha-256 auth; otherwise use trust auth.
  const args = ['-D', dataDir, '-U', superuser, '--encoding=UTF8'];
  let pwFile: string | null = null;

  if (password && password.length > 0) {
    pwFile = path.join(os.tmpdir(), `pgmanager-pwd-${Date.now()}-${process.pid}.txt`);
    try {
      fs.writeFileSync(pwFile, password, { mode: 0o600 });
    } catch (err: any) {
      const msg = `Cannot write password file: ${err.message}`;
      onLine?.(msg);
      return { ok: false, output: msg };
    }
    args.push('--auth=scram-sha-256', `--pwfile=${pwFile}`);
    onLine?.(`Running: ${initdbBin} -D "${dataDir}" -U ${superuser} --auth=scram-sha-256 --pwfile=<redacted> --encoding=UTF8`);
  } else {
    args.push('--auth=trust');
    onLine?.(`Running: ${initdbBin} -D "${dataDir}" -U ${superuser} --auth=trust --encoding=UTF8`);
  }

  if (extraPath.length) onLine?.(`DLL search dirs: ${extraPath.join(' | ')}`);

  try {
    return await pgCtlRun(initdbBin, args, onLine, { cwd: binDir, extraPath });
  } finally {
    if (pwFile) {
      try { fs.unlinkSync(pwFile); } catch { /* ignore */ }
    }
  }
}

export async function startInstance(
  pgCtlBin: string,
  instance: Instance,
  onLine?:  (line: string) => void,
): Promise<PgCtlResult> {
  // System-managed Windows service: always use `net start`. Using pg_ctl
  // against a service-managed data dir under Program Files requires admin
  // and produces inconsistent status results.
  if (process.platform === 'win32' && instance.winServiceName) {
    return windowsServiceAction(instance.winServiceName, 'start', onLine);
  }

  // Linux systemd-managed instance.
  if (process.platform !== 'win32' && instance.systemdService) {
    return systemdServiceAction(instance.systemdService, 'start', onLine);
  }

  // Remote instance (host is set and not loopback) with no managed service
  // registered — we cannot drive pg_ctl against a machine we don't run on.
  const host = instance.host ?? '127.0.0.1';
  const isRemote = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
  if (isRemote) {
    const msg = `Remote instance at ${host}:${instance.port} — start/stop is managed externally. Configure a systemd service name to control it.`;
    onLine?.(msg);
    return { ok: false, output: msg };
  }

  if (pgCtlBin) {
    const logDir  = path.join(instance.dataDir, 'pg_log');
    const logFile = path.join(logDir, 'startup.log');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore if can't create */ }
    const binDir    = path.dirname(pgCtlBin);
    const extraPath = windowsDllDirs(pgCtlBin);
    const result = await pgCtlRun(
      pgCtlBin,
      ['start', '-D', instance.dataDir, '-o', `-p ${instance.port}`, '-l', logFile, '-w', '-t', '30'],
      onLine,
      { cwd: binDir, extraPath },
    );

    // On failure, pg_ctl's own stdout is terse ("could not start server —
    // examine the log output"). Read the tail of the log file that pg_ctl
    // writes to (`-l logFile`) and surface it to the user.
    if (!result.ok) {
      const tail = readLogTail(logFile, 40);
      if (tail) {
        const header = `\n── postgres log (${logFile}) ──`;
        onLine?.(header);
        tail.split('\n').forEach(l => onLine?.(l));
        return {
          ok: false,
          output: `${result.output}${header}\n${tail}\n── end of log ──`,
        };
      } else {
        const msg = `No log file found at ${logFile}. Check that the data directory exists and is writable.`;
        onLine?.(msg);
        return { ok: false, output: `${result.output}\n${msg}` };
      }
    }

    return result;
  }

  return { ok: false, output: 'pg_ctl not found and no managed service configured for this instance.' };
}

export async function stopInstance(
  pgCtlBin: string,
  instance: Instance,
  onLine?:  (line: string) => void,
): Promise<PgCtlResult> {
  // System-managed Windows service: always use `net stop`.
  if (process.platform === 'win32' && instance.winServiceName) {
    return windowsServiceAction(instance.winServiceName, 'stop', onLine);
  }

  // Linux systemd-managed instance.
  if (process.platform !== 'win32' && instance.systemdService) {
    return systemdServiceAction(instance.systemdService, 'stop', onLine);
  }

  // Remote instance with no managed service — refuse to drive pg_ctl at it.
  const host = instance.host ?? '127.0.0.1';
  const isRemote = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
  if (isRemote) {
    const msg = `Remote instance at ${host}:${instance.port} — start/stop is managed externally. Configure a systemd service name to control it.`;
    onLine?.(msg);
    return { ok: false, output: msg };
  }

  if (pgCtlBin) {
    const binDir    = path.dirname(pgCtlBin);
    const extraPath = windowsDllDirs(pgCtlBin);
    return pgCtlRun(
      pgCtlBin,
      ['stop', '-D', instance.dataDir, '-m', 'fast'],
      onLine,
      { cwd: binDir, extraPath },
    );
  }

  return { ok: false, output: 'pg_ctl not found and no managed service configured for this instance.' };
}

export async function getInstanceStatus(
  pgCtlBin: string,
  instance: Instance,
): Promise<InstanceStatus> {
  const host = instance.host ?? '127.0.0.1';

  // For system-managed Windows service instances, prefer a TCP probe on
  // the configured port — `pg_ctl status` against Program Files data dirs
  // is unreliable without admin rights.
  if (process.platform === 'win32' && instance.winServiceName) {
    try {
      return (await isTcpPortOpen(instance.port, host)) ? 'running' : 'stopped';
    } catch {
      return 'error';
    }
  }

  // systemd-managed instance: ask systemd directly.
  if (process.platform !== 'win32' && instance.systemdService) {
    try {
      return await systemdServiceStatus(instance.systemdService);
    } catch {
      return 'error';
    }
  }

  // Remote instance (not local): rely on TCP probe only.
  const isRemote = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
  if (isRemote) {
    try {
      return (await isTcpPortOpen(instance.port, host)) ? 'running' : 'stopped';
    } catch {
      return 'error';
    }
  }

  // Prefer pg_ctl status for user-created local instances
  if (pgCtlBin) {
    try {
      const binDir    = path.dirname(pgCtlBin);
      const extraPath = windowsDllDirs(pgCtlBin);
      const result = await pgCtlRun(pgCtlBin, ['status', '-D', instance.dataDir], undefined, { cwd: binDir, extraPath });
      if (result.output.includes('server is running')) return 'running';
      if (result.output.includes('no server running'))  return 'stopped';
      // Fall back to TCP probe if pg_ctl status is ambiguous
      return (await isTcpPortOpen(instance.port, host)) ? 'running' : 'unknown';
    } catch {
      return 'error';
    }
  }

  // No pg_ctl: TCP port probe
  try {
    return (await isTcpPortOpen(instance.port, host)) ? 'running' : 'stopped';
  } catch {
    return 'error';
  }
}

/** Find the next free TCP port starting at `start`, skipping any ports
 *  already registered to another pgmanager instance. */
export async function findFreePort(
  start:    number   = 5432,
  reserved: number[] = [],
): Promise<number> {
  const reservedSet = new Set(reserved);

  const isPortFree = (port: number): Promise<boolean> =>
    new Promise(resolve => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => { srv.close(); resolve(true); });
      srv.listen(port, '127.0.0.1');
    });

  let port = start;
  while (port < 65535) {
    if (!reservedSet.has(port) && await isPortFree(port)) return port;
    port++;
  }
  return start; // fallback
}

