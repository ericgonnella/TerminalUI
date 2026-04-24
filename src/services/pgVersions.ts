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

/** Returns the bin directory for a managed major version, or null if not installed. */
export function managedBinDir(major: number): string | null {
  const dir = path.join(versionDir(major), 'pgsql', 'bin');
  if (!fs.existsSync(dir)) return null;
  const exe = process.platform === 'win32' ? 'initdb.exe' : 'initdb';
  if (!fs.existsSync(path.join(dir, exe))) return null;
  return dir;
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
 * Download and extract a portable PostgreSQL release.
 * Calls `onProgress` repeatedly so the UI can show a progress bar.
 */
export async function downloadVersion(
  release:    PgRelease,
  onProgress: ProgressCallback,
): Promise<{ ok: boolean; message: string }> {
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
