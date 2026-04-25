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
 */
async function installViaApt(
  release:    PgRelease,
  onProgress: ProgressCallback,
): Promise<{ ok: boolean; message: string }> {
  const { spawnSync } = await import('child_process');

  /** Run a command; if it fails with a permission error, transparently retry with sudo. */
  function run(cmd: string, args: string[], timeout = 180_000): { ok: boolean; out: string } {
    let r = spawnSync(cmd, args, { stdio: 'pipe', timeout });
    if (r.status === 0) return { ok: true, out: '' };
    const stderr = r.stderr?.toString() ?? '';
    if (
      stderr.includes('Permission denied') || stderr.includes('must be root') ||
      stderr.includes('EACCES')            || stderr.includes('superuser')
    ) {
      r = spawnSync('sudo', [cmd, ...args], { stdio: 'pipe', timeout });
    }
    return { ok: r.status === 0, out: r.stderr?.toString().trim() ?? '' };
  }

  onProgress({ phase: 'downloading', downloaded: 0, total: 0,
    message: `Installing postgresql-${release.major} via apt-get…` });

  // First attempt: package may already be in default repos (e.g. pg-15 on Debian Bookworm).
  let res = run('apt-get', ['install', '-y', `postgresql-${release.major}`]);

  if (!res.ok) {
    // Package not found — set up the PGDG repository and retry.
    onProgress({ phase: 'downloading', downloaded: 0, total: 0,
      message: 'Adding PostgreSQL PGDG apt repository…' });

    // Ensure prerequisites are available.
    run('apt-get', ['install', '-y', 'curl', 'ca-certificates', 'gnupg', 'lsb-release']);

    // Import the PGDG GPG signing key (pipe via bash; all strings are hardcoded, no user input).
    const keyDest = '/etc/apt/trusted.gpg.d/postgresql.gpg';
    const keyCmd =
      `curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o ${keyDest}` +
      ` || curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o ${keyDest}`;
    const keyR = spawnSync('bash', ['-c', keyCmd], { stdio: 'pipe', timeout: 30_000 });
    if (keyR.status !== 0) {
      return { ok: false, message: `Failed to import PGDG apt key:\n${keyR.stderr?.toString().slice(0, 300)}` };
    }

    // Detect the distro codename (e.g. "bookworm") for the repo line.
    const lsb = spawnSync('lsb_release', ['-cs'], { stdio: 'pipe', timeout: 5_000 });
    const codename = lsb.status === 0 ? lsb.stdout.toString().trim() : 'bookworm';

    // Write the PGDG sources.list entry.
    const repoLine = `deb https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main`;
    const repoFile = '/etc/apt/sources.list.d/pgdg.list';
    try {
      fs.writeFileSync(repoFile, repoLine + '\n');
    } catch {
      // Likely a permission error — write via sudo tee.
      const r2 = spawnSync(
        'bash',
        ['-c', `printf '%s\\n' '${repoLine}' | sudo tee ${repoFile} > /dev/null`],
        { stdio: 'pipe', timeout: 10_000 },
      );
      if (r2.status !== 0) {
        return { ok: false, message: 'Failed to write PGDG repository list. Run pgmanager as root or grant sudo.' };
      }
    }

    // Refresh package lists.
    onProgress({ phase: 'downloading', downloaded: 0, total: 0, message: 'Running apt-get update…' });
    const upd = run('apt-get', ['update', '-qq'], 120_000);
    if (!upd.ok) {
      return { ok: false, message: `apt-get update failed:\n${upd.out.slice(0, 300)}` };
    }

    // Install the requested version.
    onProgress({ phase: 'extracting', downloaded: 0, total: 0,
      message: `Installing postgresql-${release.major}…` });
    res = run('apt-get', ['install', '-y', `postgresql-${release.major}`], 300_000);
    if (!res.ok) {
      return { ok: false, message: `apt-get install failed:\n${res.out.slice(0, 300)}` };
    }
  }

  const binDir = aptBinDir(release.major);
  if (!binDir) {
    return { ok: false,
      message: `Package installed but binaries not found at /usr/lib/postgresql/${release.major}/bin` };
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
  onProgress({ phase: 'extracting', downloaded: 0, total: 0, message: 'Extracting…' });

  try {
    if (platform() === 'linux') {
      // tar.gz — use child_process since AdmZip only handles ZIP
      const { spawnSync } = await import('child_process');
      const result = spawnSync('tar', ['xzf', tmpFile, '-C', destDir], { stdio: 'pipe' });
      if (result.status !== 0) {
        throw new Error(result.stderr?.toString() || 'tar extraction failed');
      }
    } else {
      // ZIP (Windows + macOS)
      const zip = new AdmZip(tmpFile);
      zip.extractAllTo(destDir, true);
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
