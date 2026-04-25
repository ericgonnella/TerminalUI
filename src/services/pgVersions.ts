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

/**
 * Linux-only: install PostgreSQL via apt-get.
 * Automatically adds the PGDG repository if the requested major version is not
 * available in the distribution's default apt sources.
 *
 * IMPORTANT: every external command is run via async `spawn` (NOT spawnSync)
 * so the Node event loop — and therefore the Ink renderer — keeps ticking
 * while apt is busy. spawnSync would block for minutes, freezing the UI and
 * making the terminal appear hung. We also force fully non-interactive mode
 * (DEBIAN_FRONTEND=noninteractive, dpkg force-confold, gpg --batch --yes)
 * so dpkg/gpg never prompt for overwrite confirmations from a pipe stdin.
 */
async function installViaApt(
  release:    PgRelease,
  onProgress: ProgressCallback,
): Promise<{ ok: boolean; message: string }> {

  /** Async wrapper around `spawn`. Streams stderr+stdout into `tail`, returns
   *  exit code (or non-zero on signal/error). Always inherits a non-interactive
   *  env so dpkg/apt/gpg never block waiting on a TTY prompt.
   *  onLine is called for every output line, allowing the caller to forward
   *  progress to the UI without blocking Node's event loop. */
  function spawnCollect(
    cmd:     string,
    args:    string[],
    timeout = 600_000,
    onLine?: (line: string) => void,
  ): Promise<{ code: number; out: string }> {
    return new Promise(resolve => {
      let settled = false;
      let out     = '';
      const env = {
        ...process.env,
        DEBIAN_FRONTEND: 'noninteractive',
        // Suppress dialog/readline-based prompts.
        DEBCONF_NONINTERACTIVE_SEEN: 'true',
        APT_LISTCHANGES_FRONTEND:    'none',
        NEEDRESTART_MODE:            'a',
      };
      let proc;
      try {
        proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      } catch (err: any) {
        resolve({ code: 1, out: err?.message ?? 'spawn failed' });
        return;
      }
      const handle = (b: Buffer) => {
        const text = b.toString();
        out += text;
        if (onLine) {
          text.split(/\r?\n/).filter(Boolean).forEach(onLine);
        }
      };
      proc.stdout?.on('data', handle);
      proc.stderr?.on('data', handle);
      const timer = setTimeout(() => {
        if (settled) return;
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        // Give it a beat, then SIGKILL.
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
      }, timeout);
      proc.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: 1, out: out + (err?.message ?? '') });
      });
      proc.on('exit', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? 1, out });
      });
    });
  }

  /** Run a command; if it fails with a permission error, transparently retry with sudo. */
  async function run(cmd: string, args: string[], timeout = 600_000, onLine?: (line: string) => void): Promise<{ ok: boolean; out: string }> {
    let r = await spawnCollect(cmd, args, timeout, onLine);
    if (r.code === 0) return { ok: true, out: r.out };
    const stderr = r.out;
    if (
      stderr.includes('Permission denied') || stderr.includes('must be root') ||
      stderr.includes('EACCES')            || stderr.includes('superuser') ||
      stderr.includes('are you root')      || stderr.includes('not permitted')
    ) {
      // Use `-n` so sudo never prompts for a password from a pipe (which would
      // hang forever). The user must have NOPASSWD or a cached credential.
      r = await spawnCollect('sudo', ['-n', cmd, ...args], timeout, onLine);
    }
    return { ok: r.code === 0, out: r.out.trim() };
  }

  /** dpkg-friendly apt-get options for fully non-interactive runs. */
  const APT_NONINTERACTIVE = [
    '-y', '-q',
    '-o', 'Dpkg::Options::=--force-confdef',
    '-o', 'Dpkg::Options::=--force-confold',
    // Fail after 60 s rather than waiting forever if another process holds the
    // dpkg lock (e.g. unattended-upgrades running at boot on Ubuntu VPS).
    '-o', 'DPkg::Lock::Timeout=60',
  ];

  onProgress({ phase: 'downloading', downloaded: 0, total: 0,
    message: `Installing postgresql-${release.major} via apt-get…` });

  // Helper: emit an error phase to the UI before bailing out, otherwise the
  // DownloadPgScreen would stay stuck on the last "downloading" message.
  const fail = (message: string): { ok: false; message: string } => {
    onProgress({ phase: 'error', downloaded: 0, total: 0, message });
    return { ok: false, message };
  };

  // Sanity check: must be able to write to /etc/apt as root, or have sudo -n.
  // If we can't, every subsequent apt step would fail silently. Surface this
  // up-front so the user knows immediately what to fix.
  if (process.getuid && process.getuid() !== 0) {
    const sudoCheck = await spawnCollect('sudo', ['-n', 'true'], 5_000);
    if (sudoCheck.code !== 0) {
      return fail(
        'pgmanager must be run as root or by a user with passwordless sudo (NOPASSWD).\n' +
        'Try:  sudo pgmanager   — or add yourself to /etc/sudoers.d/ with NOPASSWD: ALL'
      );
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

  // First attempt: package may already be in default repos (e.g. pg-15 on Debian Bookworm).
  let res = await run('apt-get', ['install', ...APT_NONINTERACTIVE, `postgresql-${release.major}`], 600_000, forwardLine);

  if (!res.ok) {
    // Package not found — set up the PGDG repository and retry.
    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: 'Adding PostgreSQL PGDG apt repository…' });

    // Ensure prerequisites are available.
    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: 'Installing prerequisites (curl, gnupg, lsb-release)…' });
    await run('apt-get', ['install', ...APT_NONINTERACTIVE, 'curl', 'ca-certificates', 'gnupg', 'lsb-release'], 120_000, forwardLine);

    // Import the PGDG GPG signing key. `gpg --batch --yes` makes overwrite
    // non-interactive — without it, gpg blocks forever asking the user to
    // confirm overwriting an existing keyring file.
    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: 'Downloading PostgreSQL signing key from postgresql.org…' });
    const keyDest = '/etc/apt/trusted.gpg.d/postgresql.gpg';
    const keyCmd =
      `set -e; ` +
      `curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc ` +
      `| gpg --batch --yes --dearmor -o ${keyDest} ` +
      `|| (curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc ` +
      `   | sudo -n gpg --batch --yes --dearmor -o ${keyDest})`;
    const keyR = await spawnCollect('bash', ['-c', keyCmd], 60_000, forwardLine);
    if (keyR.code !== 0) {
      return fail(`Failed to import PGDG apt key:\n${keyR.out.slice(0, 400)}`);
    }

    // Detect the distro codename (e.g. "bookworm") for the repo line.
    const lsb = await spawnCollect('lsb_release', ['-cs'], 5_000);
    const codename = lsb.code === 0 ? lsb.out.trim() : 'bookworm';

    // Write the PGDG sources.list entry.
    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: `Writing PGDG repository list for ${codename}…` });
    const repoLine = `deb https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main`;
    const repoFile = '/etc/apt/sources.list.d/pgdg.list';
    try {
      fs.writeFileSync(repoFile, repoLine + '\n');
    } catch {
      // Likely a permission error — write via sudo tee.
      const r2 = await spawnCollect(
        'bash',
        ['-c', `printf '%s\\n' '${repoLine}' | sudo -n tee ${repoFile} > /dev/null`],
        15_000,
      );
      if (r2.code !== 0) {
        return fail('Failed to write PGDG repository list. Run pgmanager as root or grant passwordless sudo.');
      }
    }

    // Refresh package lists.
    onProgress({ phase: 'downloading', downloaded: 0, total: 0, message: 'Running apt-get update…' });
    const upd = await run('apt-get', ['update', '-qq'], 180_000, forwardLine);
    if (!upd.ok) {
      return fail(`apt-get update failed:\n${upd.out.slice(0, 400)}`);
    }

    // Install the requested version.
    onProgress({ phase: 'extracting', downloaded: 0, total: 0,
      message: `Installing postgresql-${release.major}…` });
    res = await run('apt-get', ['install', ...APT_NONINTERACTIVE, `postgresql-${release.major}`], 600_000, forwardLine);
    if (!res.ok) {
      return fail(`apt-get install failed:\n${res.out.slice(0, 400)}`);
    }
  }

  const binDir = aptBinDir(release.major);
  if (!binDir) {
    return fail(`Package installed but binaries not found at /usr/lib/postgresql/${release.major}/bin`);
  }

  onProgress({ phase: 'done', downloaded: 0, total: 0,
    message: `PostgreSQL ${release.patch} installed via apt` });
  return { ok: true, message: `PostgreSQL ${release.patch} installed via apt` };
}

/**
 * Download and extract a portable PostgreSQL release.
 * Calls `onProgress` repeatedly so the UI can show a progress bar.
 * On Linux, delegates to installViaApt (the EDB CDN blocks headless downloads).
 */
export async function downloadVersion(
  release:    PgRelease,
  onProgress: ProgressCallback,
): Promise<{ ok: boolean; message: string }> {
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

/** Delete a managed version. */
export function removeVersion(major: number): void {
  const dir = versionDir(major);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Human-readable file size string. */
export function humanBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
