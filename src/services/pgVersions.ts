/**
 * pgVersions — download and manage self-contained portable PostgreSQL releases.
 *
 * EDB publishes portable ZIP archives for every major/patch version.  These
 * ZIPs contain a `pgsql/` directory with ALL required DLLs co-located inside
 * `bin/` — no installer needed, no admin rights, no DLL-hell.
 *
 * Download targets (portable binaries, ~50–80 MB each):
 *   Windows x64:  https://get.enterprisedb.com/postgresql/postgresql-{ver}-1-windows-x64-binaries.zip
 *   macOS x64:    https://get.enterprisedb.com/postgresql/postgresql-{ver}-1-osx-binaries.zip
 *   Linux x64:    https://get.enterprisedb.com/postgresql/postgresql-{ver}-1-linux-x64-binaries.tar.gz
 *
 * Installed under:  ~/.pgmanager/pg-versions/<major>/  (e.g. 17, 16, 15 …)
 */

import * as fs      from 'fs';
import * as path    from 'path';
import * as os      from 'os';
import * as https   from 'https';
import * as http    from 'http';
import { spawn }    from 'child_process';
import AdmZip       from 'adm-zip';

// ─── Version catalog ──────────────────────────────────────────────────────────

export interface PgRelease {
  major:   number;   // 17, 16, 15, …
  patch:   string;   // '17.7', '16.8', …
  label:   string;   // shown in UI
}

/** Latest patch release per major version.  Update when new patches ship. */
export const PG_RELEASES: PgRelease[] = [
  { major: 17, patch: '17.7', label: 'PostgreSQL 17.7  (latest)' },
  { major: 16, patch: '16.8', label: 'PostgreSQL 16.8' },
  { major: 15, patch: '15.12', label: 'PostgreSQL 15.12' },
  { major: 14, patch: '14.17', label: 'PostgreSQL 14.17' },
  { major: 13, patch: '13.20', label: 'PostgreSQL 13.20' },
];

function platform(): 'windows' | 'macos' | 'linux' {
  if (process.platform === 'win32')  return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function downloadUrl(patch: string): string {
  const p = platform();
  const base = 'https://get.enterprisedb.com/postgresql';
  if (p === 'windows') return `${base}/postgresql-${patch}-1-windows-x64-binaries.zip`;
  if (p === 'macos')   return `${base}/postgresql-${patch}-1-osx-binaries.zip`;
  return `${base}/postgresql-${patch}-1-linux-x64-binaries.tar.gz`;
}

// ─── Install paths ───────────────────────────────────────────────────────────

export function versionsRoot(): string {
  return path.join(os.homedir(), '.pgmanager', 'pg-versions');
}

/** Install root for a specific major version. */
export function versionDir(major: number): string {
  return path.join(versionsRoot(), String(major));
}

/** On Linux, check the PGDG apt install path (/usr/lib/postgresql/{major}/bin). */
function aptBinDir(major: number): string | null {
  if (process.platform !== 'linux') return null;
  const dir = `/usr/lib/postgresql/${major}/bin`;
  if (!fs.existsSync(path.join(dir, 'initdb'))) return null;
  return dir;
}

/** Returns the bin directory for a managed major version, or null if not installed. */
export function managedBinDir(major: number): string | null {
  // Check the self-contained EDB download path (~/.pgmanager/pg-versions/{major}/pgsql/bin)
  const dir = path.join(versionDir(major), 'pgsql', 'bin');
  if (fs.existsSync(dir)) {
    const exe = process.platform === 'win32' ? 'initdb.exe' : 'initdb';
    if (fs.existsSync(path.join(dir, exe))) return dir;
  }
  // On Linux, also accept system PGDG apt installs
  return aptBinDir(major);
}

/** All installed major versions, sorted newest first. */
export function installedMajors(): number[] {
  const root = versionsRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map(n => parseInt(n, 10))
    .filter(n => !isNaN(n) && managedBinDir(n) !== null)
    .sort((a, b) => b - a);
}

// ─── Download ────────────────────────────────────────────────────────────────

export type ProgressCallback = (opts: {
  phase:      'downloading' | 'extracting' | 'done' | 'error';
  downloaded: number;
  total:      number;
  message?:   string;
}) => void;

function cleanTerminalStatus(input: string): string {
  return input
    // Strip ANSI / CSI escape sequences before React Ink writes the text.
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    // apt and dpkg often redraw progress with carriage returns. Preserve only
    // the newest segment so it cannot move the terminal cursor when rendered.
    .split(/\r+/)
    .pop()!
    // Drop remaining C0 controls except tab, then keep status text bounded.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/**
 * Linux-only: install PostgreSQL via apt-get.
 * Automatically adds the PGDG repository if the requested major version is not
 * available in the distribution's default apt sources.
 *
 * IMPORTANT: every external command is run via async `spawn` (NOT spawnSync)
 * so the Node event loop — and therefore the Ink renderer — keeps ticking
 * while apt is busy. spawnSync would block for minutes, freezing the UI and
 * making the terminal appear hung.
 *
 * Non-interactive mode is enforced from MULTIPLE angles, because each one has
 * a known failure mode on real-world VPS images:
 *
 *   1. Environment vars (DEBIAN_FRONTEND, APT_LISTCHANGES_FRONTEND, …) are
 *      passed BOTH on the spawn-env AND as inline `VAR=val` arguments to sudo
 *      so they survive sudo's default `env_reset` (the most common cause of
 *      apt-get hanging at "apt-listchanges: Reading changelogs..." on Ubuntu —
 *      sudo strips the env, apt-listchanges goes interactive, blocks forever).
 *   2. apt-get is invoked with `-o` overrides for every interactive knob
 *      (Dpkg::Use-Pty, DPkg::Pre-Install-Pkgs, lock timeout, etc.) so even if
 *      the env vars are dropped, apt cannot stop to ask a question.
 *   3. dpkg state is recovered first (`dpkg --configure -a`, `apt-get -fy
 *      install`) so a previous interrupted install doesn't wedge every
 *      subsequent attempt.
 *   4. The dpkg lock is probed up-front; if held by another process we name
 *      the holder instead of silently waiting.
 *   5. Full output is tee'd to `~/.pgmanager/logs/install-pgN-<ts>.log` so the
 *      user has something concrete to read when the truncated UI message
 *      isn't enough.
 */
function installLogPath(major: number): string {
  const dir = path.join(os.homedir(), '.pgmanager', 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `install-pg${major}-${ts}.log`);
}

async function installViaApt(
  release:    PgRelease,
  onProgress: ProgressCallback,
): Promise<{ ok: boolean; message: string; logPath?: string }> {

  const logPath = installLogPath(release.major);
  let logStream: fs.WriteStream | null = null;
  try { logStream = fs.createWriteStream(logPath, { flags: 'a' }); } catch { /* ignore */ }
  const logRaw = (text: string): void => {
    try { logStream?.write(text); } catch { /* ignore */ }
  };
  const logLine = (line: string): void => logRaw(`[${new Date().toISOString()}] ${line}\n`);
  logLine(`pgmanager install start: postgresql-${release.major} (${release.patch})`);
  logLine(`uid=${process.getuid?.() ?? '?'} platform=${process.platform} cwd=${process.cwd()}`);

  /** Env vars that MUST reach apt/dpkg/gpg. Set both in spawn-env and passed
   *  to sudo as inline VAR=val args (sudo's env_reset strips spawn-env). */
  const NONINTERACTIVE_ENV: Record<string, string> = {
    DEBIAN_FRONTEND:             'noninteractive',
    DEBCONF_NONINTERACTIVE_SEEN: 'true',
    APT_LISTCHANGES_FRONTEND:    'none',
    APT_LISTBUGS_FRONTEND:       'none',
    NEEDRESTART_MODE:            'a',
    NEEDRESTART_SUSPEND:         '1',
    TERM:                        'dumb',
    NO_COLOR:                    '1',
    APT_PROGRESS_FANCY:          '0',
    LC_ALL:                      'C.UTF-8',
    LANG:                        'C.UTF-8',
  };

  /** Async wrapper around `spawn`. Streams stderr+stdout into `out`, mirrors
   *  every line to the install log, and resolves with exit code. */
  function spawnCollect(
    cmd:     string,
    args:    string[],
    timeout = 600_000,
    onLine?: (line: string) => void,
  ): Promise<{ code: number; out: string; timedOut: boolean }> {
    return new Promise(resolve => {
      let settled  = false;
      let timedOut = false;
      let out      = '';
      const env = { ...process.env, ...NONINTERACTIVE_ENV };
      logLine(`exec: ${cmd} ${args.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}`);
      let proc;
      try {
        proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      } catch (err: any) {
        const msg = err?.message ?? 'spawn failed';
        logLine(`spawn-error: ${msg}`);
        resolve({ code: 1, out: msg, timedOut: false });
        return;
      }
      const handle = (b: Buffer) => {
        const text = b.toString();
        out += text;
        logRaw(text);
        if (onLine) {
          text.split(/[\r\n]+/)
            .map(cleanTerminalStatus)
            .filter(Boolean)
            .forEach(onLine);
        }
      };
      proc.stdout?.on('data', handle);
      proc.stderr?.on('data', handle);
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        logLine(`timeout after ${timeout}ms — killing pid ${proc.pid}`);
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
      }, timeout);
      proc.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logLine(`error: ${err?.message ?? 'unknown'}`);
        resolve({ code: 1, out: out + (err?.message ?? ''), timedOut });
      });
      proc.on('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logLine(`exit: code=${code} signal=${signal ?? '-'} timedOut=${timedOut}`);
        resolve({ code: code ?? (signal ? 1 : 1), out, timedOut });
      });
    });
  }

  const isRoot = process.getuid ? process.getuid() === 0 : false;

  /** Build the argv list for sudo, including inline VAR=val pairs so the
   *  non-interactive env survives sudo's `env_reset`. */
  function sudoArgs(cmd: string, args: string[]): string[] {
    const envPairs = Object.entries(NONINTERACTIVE_ENV).map(([k, v]) => `${k}=${v}`);
    // -n  never prompt for a password (must have NOPASSWD or cached creds)
    // -E  preserve env (works on sudoers with appropriate policy; combined
    //     with explicit VAR=val args we get the strongest guarantee)
    return ['-n', '-E', ...envPairs, cmd, ...args];
  }

  /** Run a privileged command. If we're already root, run direct.
   *  Otherwise always go through sudo (we already verified sudo -n works). */
  async function runPriv(
    cmd:     string,
    args:    string[],
    timeout = 600_000,
    onLine?: (line: string) => void,
  ): Promise<{ ok: boolean; out: string; timedOut: boolean }> {
    const r = isRoot
      ? await spawnCollect(cmd, args, timeout, onLine)
      : await spawnCollect('sudo', sudoArgs(cmd, args), timeout, onLine);
    return { ok: r.code === 0, out: r.out.trim(), timedOut: r.timedOut };
  }

  /** dpkg-friendly apt-get options for fully non-interactive runs. Each one
   *  guards against a specific failure mode we've observed in the wild. */
  const APT_NONINTERACTIVE = [
    '-y', '-q',
    '--no-install-recommends',   // don't pull in postgresql-18 when user wants 17
    '--no-install-suggests',
    '-o', 'Dpkg::Use-Pty=0',
    '-o', 'APT::Color=0',
    '-o', 'APT::Get::Assume-Yes=true',
    '-o', 'Dpkg::Options::=--force-confdef',
    '-o', 'Dpkg::Options::=--force-confold',
    // Disable apt-listchanges entirely — it's the #1 cause of hangs over SSH
    // because it tries to invoke a pager that has no controlling TTY.
    '-o', 'DPkg::Pre-Install-Pkgs::=',
    '-o', 'Apt::Cmd::Disable-Script-Warning=1',
    // Fail after 120 s rather than waiting forever if another process holds
    // the dpkg lock (unattended-upgrades on Ubuntu VPS, etc.).
    '-o', 'DPkg::Lock::Timeout=120',
    // Retry HTTP fetches a few times — VPS networking is flaky.
    '-o', 'Acquire::Retries=3',
  ];

  /** Extract actionable error lines from apt/dpkg output. */
  function extractAptErrors(out: string): string[] {
    return out.split('\n')
      .filter(l => /^\s*(E:|Err:|dpkg: error|dpkg:.*conflict|error processing|unmet dep)/i.test(l))
      .map(l => l.trim())
      .filter(Boolean)
      .slice(-8);
  }

  /** Emit an error phase to the UI. Log path and E: lines go FIRST so they are
   *  always visible at the top of the error box — never scrolled off-screen. */
  const fail = (summary: string, rawOut?: string): { ok: false; message: string; logPath: string } => {
    const errLines = rawOut ? extractAptErrors(rawOut) : [];
    const parts: string[] = [
      `Log: ${logPath}`,
      '',
      summary,
    ];
    if (errLines.length > 0) {
      parts.push('');
      parts.push(...errLines);
    }
    const full = parts.join('\n');
    logLine(`FAIL: ${full}`);
    onProgress({ phase: 'error', downloaded: 0, total: 0, message: full });
    try { logStream?.end(); } catch { /* ignore */ }
    return { ok: false, message: full, logPath };
  };

  onProgress({ phase: 'downloading', downloaded: 0, total: 0,
    message: `Installing postgresql-${release.major} via apt-get…` });

  // ── Step 0: privilege check ───────────────────────────────────────────────
  // Fail fast with a clear, actionable message if we can't elevate.
  if (!isRoot) {
    const sudoCheck = await spawnCollect('sudo', ['-n', 'true'], 5_000);
    if (sudoCheck.code !== 0) {
      // sudo is either missing, requires a password, or this user isn't a sudoer.
      const binPath = process.argv[1] ?? 'pgmanager';
      return fail(
        'pgmanager needs root privileges to run apt-get, but `sudo -n` is not available.\n' +
        '\n' +
        'Pick one:\n' +
        `  • Re-run with sudo using the FULL path:   sudo "${binPath}"\n` +
        '  • Or preserve your PATH:                  sudo -E env "PATH=$PATH" pgmanager\n' +
        '  • Or install pgmanager system-wide:       sudo npm install -g pgmanager\n' +
        '  • Or grant passwordless sudo to your user (NOPASSWD: ALL in /etc/sudoers.d/).'
      );  // (no rawOut for this failure — it's a pre-flight check)
    }
  }

  // Throttle apt output lines to the UI: max one progress update every 300ms.
  // Without throttling, a verbose apt run emits hundreds of lines/second which
  // would trigger hundreds of Ink re-renders and cause extreme terminal flicker.
  let lastProgressMs = 0;
  const forwardLine = (line: string): void => {
    const now = Date.now();
    if (now - lastProgressMs >= 300) {
      lastProgressMs = now;
      onProgress({ phase: 'downloading', downloaded: 0, total: 0, message: line });
    }
  };

  // ── Step 1: probe for a held dpkg lock ────────────────────────────────────
  // unattended-upgrades on fresh Ubuntu VPS images frequently holds this for
  // 5–15 minutes after first boot. If we don't tell the user, they think
  // pgmanager is broken.
  onProgress({ phase: 'downloading', downloaded: 0, total: 0,
    message: 'Checking dpkg/apt locks…' });
  const lockProbe = await runPriv(
    'bash',
    ['-c',
      'for f in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock; do ' +
      '  if command -v fuser >/dev/null 2>&1 && fuser "$f" >/dev/null 2>&1; then ' +
      '    echo "LOCKED: $f"; ps -o pid,user,comm,args -p $(fuser "$f" 2>/dev/null | tr -s " ") 2>/dev/null || true; ' +
      '  fi; ' +
      'done; ' +
      'true'
    ],
    15_000,
  );
  if (lockProbe.out.includes('LOCKED:')) {
    const holder = lockProbe.out.split('\n').slice(0, 6).join('\n');
    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: 'dpkg lock held — will wait up to 120 s…' });
    logLine(`lock held:\n${holder}`);
    // Don't fail yet — DPkg::Lock::Timeout=120 will give it 2 minutes to
    // release. If it doesn't, the install command will surface the failure.
  }

  // ── Step 2: recover from any prior broken dpkg state ──────────────────────
  // A previous interrupted install (Ctrl-C, network drop, OOM kill) leaves
  // dpkg in a state where every subsequent install fails with "dpkg was
  // interrupted". This is exactly the symptom the user reported.
  onProgress({ phase: 'downloading', downloaded: 0, total: 0,
    message: 'Recovering dpkg state (dpkg --configure -a)…' });
  const cfg = await runPriv('dpkg', ['--configure', '-a'], 300_000, forwardLine);
  if (!cfg.ok) {
    logLine(`dpkg --configure -a non-zero (continuing): ${cfg.out.slice(-400)}`);
  }
  onProgress({ phase: 'downloading', downloaded: 0, total: 0,
    message: 'Fixing broken packages (apt-get install -fy)…' });
  const fix = await runPriv('apt-get', ['install', ...APT_NONINTERACTIVE, '-f'], 300_000, forwardLine);
  if (!fix.ok) {
    logLine(`apt-get -fy non-zero (continuing): ${fix.out.slice(-400)}`);
  }

  // ── Step 3: first install attempt (default repos) ─────────────────────────
  onProgress({ phase: 'downloading', downloaded: 0, total: 0,
    message: `Trying apt-get install postgresql-${release.major} from default repos…` });
  let res = await runPriv(
    'apt-get',
    ['install', ...APT_NONINTERACTIVE, `postgresql-${release.major}`],
    900_000,
    forwardLine,
  );

  if (!res.ok) {
    // Distinguish "package not found" (need PGDG) from real failures (lock
    // timeout, network, broken deps) so we don't bash on with PGDG when the
    // real problem is something else.
    const out = res.out;
    const notFound =
      /Unable to locate package/i.test(out) ||
      /has no installation candidate/i.test(out) ||
      /Couldn't find any package/i.test(out);

    if (!notFound) {
      // A real failure — surface it instead of silently wandering off into
      // PGDG repo setup.
      if (res.timedOut) {
        return fail(
          'apt-get install timed out (15 min). Likely causes:\n' +
          '  • dpkg lock held by another process (unattended-upgrades, snapd)\n' +
          '  • slow / blocked network to deb.debian.org',
          out,
        );
      }
      return fail('apt-get install failed (see E: lines and log above)', out);
    }

    // ── Step 4: set up the PGDG repo and retry ──────────────────────────────
    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: 'Adding PostgreSQL PGDG apt repository…' });

    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: 'Installing prerequisites (curl, gnupg, lsb-release)…' });
    const prereq = await runPriv(
      'apt-get',
      ['install', ...APT_NONINTERACTIVE, 'curl', 'ca-certificates', 'gnupg', 'lsb-release'],
      300_000, forwardLine,
    );
    if (!prereq.ok) {
      return fail('Failed to install prerequisites (curl, gnupg, lsb-release)', prereq.out);
    }

    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: 'Downloading PostgreSQL signing key from postgresql.org…' });
    const keyDest = '/etc/apt/trusted.gpg.d/postgresql.gpg';
    const keyR = await runPriv(
      'bash',
      ['-c',
        `set -o pipefail; ` +
        `curl -fsSL --max-time 30 https://www.postgresql.org/media/keys/ACCC4CF8.asc ` +
        `| gpg --batch --yes --dearmor -o ${keyDest}`
      ],
      90_000, forwardLine,
    );
    if (!keyR.ok) {
      return fail('Failed to import PGDG apt key from postgresql.org', keyR.out);
    }

    // Detect the distro codename (e.g. "bookworm") for the repo line.
    const lsb = await spawnCollect('bash',
      ['-c', 'lsb_release -cs 2>/dev/null || (. /etc/os-release && echo "$VERSION_CODENAME")'],
      10_000);
    const codename = lsb.code === 0 ? lsb.out.trim().split('\n').pop()!.trim() : 'bookworm';
    if (!codename || /\s/.test(codename)) {
      return fail(`Could not detect distro codename (got: "${codename}"). Run 'lsb_release -cs' to verify.`);
    }

    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: `Writing PGDG repository list for ${codename}…` });
    const repoLine = `deb https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main`;
    const repoFile = '/etc/apt/sources.list.d/pgdg.list';
    const repoR = await runPriv(
      'bash',
      ['-c', `printf '%s\\n' ${JSON.stringify(repoLine)} > ${repoFile}`],
      15_000,
    );
    if (!repoR.ok) {
      return fail(`Failed to write ${repoFile}`, repoR.out);
    }

    onProgress({ phase: 'downloading', downloaded: 0, total: 0, message: 'Running apt-get update…' });
    const upd = await runPriv('apt-get', ['update', ...APT_NONINTERACTIVE.filter(a => a !== '-q')], 300_000, forwardLine);
    if (!upd.ok) {
      return fail('apt-get update failed (PGDG)', upd.out);
    }

    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: `Installing postgresql-${release.major} from PGDG…` });
    res = await runPriv(
      'apt-get',
      ['install', ...APT_NONINTERACTIVE, `postgresql-${release.major}`],
      900_000, forwardLine,
    );
    if (!res.ok) {
      if (res.timedOut) {
        return fail(
          'apt-get install (PGDG) timed out (15 min). Likely causes:\n' +
          '  • dpkg lock held by another process\n' +
          '  • slow or blocked network to apt.postgresql.org',
          res.out,
        );
      }
      return fail('apt-get install (PGDG) failed (see E: lines and log above)', res.out);
    }
  }

  const binDir = aptBinDir(release.major);
  if (!binDir) {
    return fail(`Package installed but binaries not found at /usr/lib/postgresql/${release.major}/bin/initdb`);
  }

  logLine(`SUCCESS: binaries at ${binDir}`);
  try { logStream?.end(); } catch { /* ignore */ }
  onProgress({ phase: 'done', downloaded: 0, total: 0,
    message: `PostgreSQL ${release.patch} installed via apt (log: ${logPath})` });
  return { ok: true, message: `PostgreSQL ${release.patch} installed via apt`, logPath };
}

/**
 * Download and extract a portable PostgreSQL release.
 * Calls `onProgress` repeatedly so the UI can show a progress bar.
 * On Linux, delegates to installViaApt (the EDB CDN blocks headless downloads).
 */
export async function downloadVersion(
  release:    PgRelease,
  onProgress: ProgressCallback,
): Promise<{ ok: boolean; message: string; logPath?: string }> {
  // On Linux, use apt-get / PGDG — the EDB binary CDN returns HTTP 403 on Linux.
  if (platform() === 'linux') {
    return installViaApt(release, onProgress);
  }

  const url     = downloadUrl(release.patch);
  const destDir = versionDir(release.major);

  // Wipe any partial install first
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  // ── Step 1: download to a temp file ──────────────────────────────────────
  const tmpFile = path.join(destDir, '_download.tmp');

  try {
    await new Promise<void>((resolve, reject) => {
      let downloaded = 0;
      let total      = 0;

      function request(requestUrl: string, redirectCount = 0): void {
        if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }

        const proto = requestUrl.startsWith('https') ? https : http;
        proto.get(requestUrl, (res) => {
          // Follow redirects
          if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
            request(res.headers.location, redirectCount + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} from ${requestUrl}`));
            return;
          }

          total = parseInt(res.headers['content-length'] ?? '0', 10);
          const out = fs.createWriteStream(tmpFile);

          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            onProgress({ phase: 'downloading', downloaded, total });
          });
          res.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          res.on('error', reject);
        }).on('error', reject);
      }

      request(url);
    });
  } catch (err: any) {
    onProgress({ phase: 'error', downloaded: 0, total: 0, message: `Download failed: ${err.message}` });
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    return { ok: false, message: `Download failed: ${err.message}` };
  }

  // ── Step 2: extract ──────────────────────────────────────────────────────
  // Signal the UI that we've moved to the extraction phase.
  onProgress({ phase: 'extracting', downloaded: 0, total: 0, message: 'Extracting…' });

  // Extraction can take 10–30 s for a 60–80 MB ZIP. We run it off the main
  // thread so the Node event loop stays free and the UI spinner keeps updating.
  // • Windows / macOS: AdmZip run inside a worker_threads Worker (same speed
  //   as synchronous extraction, but non-blocking for the Ink renderer).
  // • Linux EDB portable path: spawn tar asynchronously.
  try {
    let extractSecs = 0;
    const extractTimer = setInterval(() => {
      extractSecs++;
      onProgress({
        phase: 'extracting',
        downloaded: 0,
        total: 0,
        message: `Extracting… ${extractSecs}s`,
      });
    }, 1000);

    try {
      if (platform() === 'linux') {
        // tar.gz — async spawn so event loop stays free
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('tar', ['xzf', tmpFile, '-C', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
          let errOut = '';
          proc.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
          proc.on('error', reject);
          proc.on('exit', (code) => {
            if (code !== 0) reject(new Error(errOut.trim() || `tar exited with code ${code}`));
            else resolve();
          });
        });
      } else {
        // ZIP (Windows + macOS): run AdmZip in a worker thread so the
        // synchronous extraction doesn't block Node's event loop.
        // The worker is eval'd inline — no separate file needed.
        const { Worker } = await import('worker_threads');
        const workerCode = [
          "const { workerData, parentPort } = require('worker_threads');",
          "const AdmZip = require('adm-zip');",
          "try {",
          "  const zip = new AdmZip(workerData.tmpFile);",
          "  zip.extractAllTo(workerData.destDir, true);",
          "  parentPort.postMessage({ ok: true });",
          "} catch (e) {",
          "  parentPort.postMessage({ ok: false, error: e.message });",
          "}",
        ].join('\n');
        await new Promise<void>((resolve, reject) => {
          const worker = new Worker(workerCode, {
            eval: true,
            workerData: { tmpFile, destDir },
          });
          worker.on('message', (msg: { ok: boolean; error?: string }) => {
            if (msg.ok) resolve();
            else reject(new Error(msg.error ?? 'Extraction failed'));
          });
          worker.on('error', reject);
        });
      }
    } finally {
      clearInterval(extractTimer);
    }

    fs.unlinkSync(tmpFile);

    // Verify it extracted correctly
    const binDir = managedBinDir(release.major);
    if (!binDir) throw new Error('Extraction completed but bin directory not found');

    onProgress({ phase: 'done', downloaded: 0, total: 0, message: `PostgreSQL ${release.patch} installed at ${destDir}` });
    return { ok: true, message: `PostgreSQL ${release.patch} installed successfully` };
  } catch (err: any) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    onProgress({ phase: 'error', downloaded: 0, total: 0, message: `Extraction failed: ${err.message}` });
    return { ok: false, message: `Extraction failed: ${err.message}` };
  }
}

/**
 * Linux-only: remove a postgresql-N package via apt-get.
 *
 * Mirrors the install path's privilege-elevation contract:
 *   - Inline `VAR=val` args to sudo so non-interactive env survives env_reset
 *     (otherwise apt-listchanges/debconf can hang waiting for a TTY).
 *   - Direct invocation if already root.
 *   - Pre-flight `sudo -n true` check with an actionable error message.
 *
 * Streams output through `onProgress` so the UI can show live status.
 */
async function removeViaApt(
  major:      number,
  onProgress: ProgressCallback,
): Promise<{ ok: boolean; message: string; logPath?: string }> {
  const logPath = path.join(
    os.homedir(),
    '.pgmanager',
    'logs',
    `remove-pg${major}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
  );
  let logStream: fs.WriteStream | null = null;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
  } catch { /* ignore */ }
  const logRaw  = (text: string): void => { try { logStream?.write(text); } catch { /* ignore */ } };
  const logLine = (line: string): void => logRaw(`[${new Date().toISOString()}] ${line}\n`);
  logLine(`pgmanager remove start: postgresql-${major}`);
  logLine(`uid=${process.getuid?.() ?? '?'} platform=${process.platform}`);

  const NONINTERACTIVE_ENV: Record<string, string> = {
    DEBIAN_FRONTEND:             'noninteractive',
    DEBCONF_NONINTERACTIVE_SEEN: 'true',
    APT_LISTCHANGES_FRONTEND:    'none',
    APT_LISTBUGS_FRONTEND:       'none',
    NEEDRESTART_MODE:            'a',
    NEEDRESTART_SUSPEND:         '1',
    TERM:                        'dumb',
    NO_COLOR:                    '1',
    LC_ALL:                      'C.UTF-8',
    LANG:                        'C.UTF-8',
  };

  function spawnCollect(
    cmd:     string,
    args:    string[],
    timeout = 600_000,
    onLine?: (line: string) => void,
  ): Promise<{ code: number; out: string; timedOut: boolean }> {
    return new Promise(resolve => {
      let settled  = false;
      let timedOut = false;
      let out      = '';
      const env = { ...process.env, ...NONINTERACTIVE_ENV };
      logLine(`exec: ${cmd} ${args.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}`);
      let proc;
      try {
        proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      } catch (err: any) {
        logLine(`spawn-error: ${err?.message ?? 'spawn failed'}`);
        resolve({ code: 1, out: err?.message ?? 'spawn failed', timedOut: false });
        return;
      }
      const handle = (b: Buffer) => {
        const text = b.toString();
        out += text;
        logRaw(text);
        if (onLine) {
          text.split(/[\r\n]+/).map(cleanTerminalStatus).filter(Boolean).forEach(onLine);
        }
      };
      proc.stdout?.on('data', handle);
      proc.stderr?.on('data', handle);
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        logLine(`timeout after ${timeout}ms — killing pid ${proc.pid}`);
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
      }, timeout);
      proc.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: 1, out: out + (err?.message ?? ''), timedOut });
      });
      proc.on('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logLine(`exit: code=${code} signal=${signal ?? '-'} timedOut=${timedOut}`);
        resolve({ code: code ?? 1, out, timedOut });
      });
    });
  }

  const isRoot = process.getuid ? process.getuid() === 0 : false;

  function sudoArgs(cmd: string, args: string[]): string[] {
    const envPairs = Object.entries(NONINTERACTIVE_ENV).map(([k, v]) => `${k}=${v}`);
    return ['-n', '-E', ...envPairs, cmd, ...args];
  }

  const fail = (summary: string, rawOut?: string): { ok: false; message: string; logPath: string } => {
    const errLines = rawOut
      ? rawOut.split('\n')
          .filter(l => /^\s*(E:|Err:|dpkg: error|error processing)/i.test(l))
          .map(l => l.trim())
          .filter(Boolean)
          .slice(-8)
      : [];
    const parts: string[] = [`Log: ${logPath}`, '', summary];
    if (errLines.length > 0) { parts.push(''); parts.push(...errLines); }
    const full = parts.join('\n');
    logLine(`FAIL: ${full}`);
    onProgress({ phase: 'error', downloaded: 0, total: 0, message: full });
    try { logStream?.end(); } catch { /* ignore */ }
    return { ok: false, message: full, logPath };
  };

  // Pre-flight: must be able to elevate.
  if (!isRoot) {
    const sudoCheck = await spawnCollect('sudo', ['-n', 'true'], 5_000);
    if (sudoCheck.code !== 0) {
      const binPath = process.argv[1] ?? 'pgmanager';
      return fail(
        'pgmanager needs root privileges to run apt-get, but `sudo -n` is not available.\n' +
        '\n' +
        'Pick one:\n' +
        `  • Re-run with sudo using the FULL path:   sudo "${binPath}"\n` +
        '  • Or preserve your PATH:                  sudo -E env "PATH=$PATH" pgmanager\n' +
        '  • Or grant passwordless sudo to your user (NOPASSWD: ALL in /etc/sudoers.d/).'
      );
    }
  }

  // Throttle apt output → UI to ~3 updates/sec to avoid Ink re-render storms.
  let lastProgressMs = 0;
  const forwardLine = (line: string): void => {
    const now = Date.now();
    if (now - lastProgressMs >= 300) {
      lastProgressMs = now;
      onProgress({ phase: 'downloading', downloaded: 0, total: 0, message: line });
    }
  };

  onProgress({ phase: 'downloading', downloaded: 0, total: 0,
    message: `Removing postgresql-${major} via apt-get…` });

  const APT_NONINTERACTIVE = [
    '-y', '-q',
    '-o', 'Dpkg::Use-Pty=0',
    '-o', 'APT::Color=0',
    '-o', 'APT::Get::Assume-Yes=true',
    '-o', 'Dpkg::Options::=--force-confdef',
    '-o', 'Dpkg::Options::=--force-confold',
    '-o', 'DPkg::Pre-Install-Pkgs::=',
    '-o', 'DPkg::Lock::Timeout=120',
  ];

  // Use --purge so config files are removed too — matches user expectation
  // of "delete this version". The data directory is NOT touched (Debian
  // packages put data at /var/lib/postgresql which is owned by the postgres
  // system user; we leave that alone so user databases aren't destroyed).
  const removeArgs = [
    'remove', ...APT_NONINTERACTIVE, '--purge',
    `postgresql-${major}`,
    `postgresql-client-${major}`,
  ];

  const r = isRoot
    ? await spawnCollect('apt-get', removeArgs, 600_000, forwardLine)
    : await spawnCollect('sudo',    sudoArgs('apt-get', removeArgs), 600_000, forwardLine);

  if (r.code !== 0) {
    if (r.timedOut) {
      return fail('apt-get remove timed out (10 min). dpkg lock may be held by another process.', r.out);
    }
    return fail(`apt-get remove exited with code ${r.code}`, r.out);
  }

  // Run autoremove to clean up orphaned dependencies — best-effort, never fail.
  const autoArgs = ['autoremove', ...APT_NONINTERACTIVE];
  await (isRoot
    ? spawnCollect('apt-get', autoArgs, 300_000, forwardLine)
    : spawnCollect('sudo',    sudoArgs('apt-get', autoArgs), 300_000, forwardLine));

  logLine('remove completed successfully');
  try { logStream?.end(); } catch { /* ignore */ }
  onProgress({ phase: 'done', downloaded: 0, total: 0,
    message: `Removed postgresql-${major}` });
  return { ok: true, message: `Removed postgresql-${major}`, logPath };
}

/**
 * Delete a managed PostgreSQL version.
 *
 * Linux behaviour: if a system apt-installed copy is present at
 * `/usr/lib/postgresql/N/`, runs `apt-get remove --purge postgresql-N`
 * (with the same sudo / non-interactive plumbing as install).
 *
 * Always also removes the portable copy at `~/.pgmanager/pg-versions/N/`
 * if present.
 */
export async function removeVersion(
  major:       number,
  onProgress?: ProgressCallback,
): Promise<{ ok: boolean; message: string; logPath?: string }> {
  const portableDir = versionDir(major);
  const portableExists = fs.existsSync(portableDir);
  const aptInstalled   = aptBinDir(major) !== null;

  // No-op safety net — should be unreachable from the UI which only offers
  // remove for installed versions, but be explicit.
  if (!portableExists && !aptInstalled) {
    const msg = `PostgreSQL ${major} is not installed.`;
    onProgress?.({ phase: 'error', downloaded: 0, total: 0, message: msg });
    return { ok: false, message: msg };
  }

  // Linux apt-managed install — delegate to apt-get.
  if (aptInstalled && process.platform === 'linux') {
    const result = await removeViaApt(major, onProgress ?? (() => {}));
    // Also clear the portable dir if the user happens to have one too.
    if (portableExists) {
      try { fs.rmSync(portableDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return result;
  }

  // Portable / Windows install — just delete the directory.
  try {
    fs.rmSync(portableDir, { recursive: true, force: true });
    const msg = `Removed PostgreSQL ${major}`;
    onProgress?.({ phase: 'done', downloaded: 0, total: 0, message: msg });
    return { ok: true, message: msg };
  } catch (err: any) {
    const msg = `Failed to remove ${portableDir}: ${err.message}`;
    onProgress?.({ phase: 'error', downloaded: 0, total: 0, message: msg });
    return { ok: false, message: msg };
  }
}

/** Human-readable file size string. */
export function humanBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
