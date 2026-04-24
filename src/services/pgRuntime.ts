/**
 * Windows "self-contained runtime" shim.
 *
 * Some EDB / pgAdmin bundled PostgreSQL installations ship the core DLLs
 * (libpq.dll, libintl-9.dll, libiconv-2.dll, libssl-3-x64.dll,
 * libcrypto-3-x64.dll) ONLY inside `pgAdmin 4\runtime\` rather than in the
 * main `bin\` folder.  Windows' modern secure DLL search does NOT find those
 * DLLs via PATH or cwd, so `initdb.exe`, `psql.exe`, etc. crash with
 * STATUS_DLL_NOT_FOUND (0xC0000135).
 *
 * This module builds a local, user-owned copy of the PG executables plus every
 * DLL they need into `~/.pgmanager/runtime/pg<version>/` so the DLLs live
 * directly next to the EXEs (DLL search rule #1) — which always works.
 * `PGSHAREDIR` is set at spawn time so `initdb` can still find its templates
 * in the original install.
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

export interface RuntimeShim {
  /** Directory holding the self-contained PG binaries + DLLs. */
  binDir:   string;
  /** Path to `PGSHAREDIR` (the original install's share/ folder). */
  shareDir: string;
  /** Copy of initdb.exe inside the shim. */
  initdb:   string;
  /** Copy of psql.exe inside the shim. */
  psql:     string;
  /** Copy of createdb.exe inside the shim. */
  createdb: string;
  /** Copy of pg_ctl.exe inside the shim (empty string if not available). */
  pgCtl:    string;
}

/** True if the given PG bin dir is already self-sufficient (libpq.dll present). */
export function binDirHasRequiredDlls(binDir: string): boolean {
  return fs.existsSync(path.join(binDir, 'libpq.dll'));
}

/** Root of the runtime shim for the given PG version. */
function shimRoot(version: string): string {
  return path.join(os.homedir(), '.pgmanager', 'runtime', `pg${version}`);
}

/** Copy src to dst only if dst is missing or older. */
function copyIfStale(src: string, dst: string): void {
  try {
    const sStat = fs.statSync(src);
    if (fs.existsSync(dst)) {
      const dStat = fs.statSync(dst);
      if (dStat.size === sStat.size && dStat.mtimeMs >= sStat.mtimeMs) return;
    }
    fs.copyFileSync(src, dst);
  } catch {
    /* missing source — ignore */
  }
}

/** Copy every .dll from `srcDir` into `dstDir`. */
function copyDlls(srcDir: string, dstDir: string): number {
  let count = 0;
  if (!fs.existsSync(srcDir)) return 0;
  for (const entry of fs.readdirSync(srcDir)) {
    if (entry.toLowerCase().endsWith('.dll')) {
      copyIfStale(path.join(srcDir, entry), path.join(dstDir, entry));
      count++;
    }
  }
  return count;
}

/** Copy a single EXE into the shim if it exists. Returns shim path or ''. */
function copyExe(srcBinDir: string, dstBinDir: string, name: string): string {
  const src = path.join(srcBinDir, name);
  if (!fs.existsSync(src)) return '';
  const dst = path.join(dstBinDir, name);
  copyIfStale(src, dst);
  return dst;
}

/**
 * Build (or reuse) a self-contained runtime shim for the given PG install.
 *
 * @param originalBinDir  The real PG bin dir (…/PostgreSQL/<ver>/bin)
 * @param version         PG version string used for the shim folder name
 * @param dllSourceDirs   Extra dirs to copy DLLs from (e.g. pgAdmin 4 runtime)
 */
export function ensureRuntimeShim(
  originalBinDir: string,
  version:        string,
  dllSourceDirs:  string[],
): RuntimeShim | null {
  if (process.platform !== 'win32') return null;
  if (!fs.existsSync(originalBinDir)) return null;

  const root       = shimRoot(version);
  const binDir     = path.join(root, 'bin');
  const pgRoot     = path.dirname(originalBinDir);
  const shareDir   = path.join(pgRoot, 'share');

  fs.mkdirSync(binDir, { recursive: true });

  // 1) Copy every DLL from the source dirs (pgAdmin runtime etc.) first —
  //    these hold the core deps (libpq, ssl, intl, iconv).
  for (const dir of dllSourceDirs) copyDlls(dir, binDir);

  // 2) Then copy DLLs from the original bin/ — these may include icu, libxml,
  //    etc.  Doing this second means original-bin DLLs override any same-name
  //    file from pgAdmin runtime (which is usually what we want).
  copyDlls(originalBinDir, binDir);

  // 3) Copy the executables we care about.
  const initdb   = copyExe(originalBinDir, binDir, 'initdb.exe');
  const psql     = copyExe(originalBinDir, binDir, 'psql.exe');
  const createdb = copyExe(originalBinDir, binDir, 'createdb.exe');
  const pgCtl    = copyExe(originalBinDir, binDir, 'pg_ctl.exe');

  if (!initdb || !psql || !createdb) return null;

  return { binDir, shareDir, initdb, psql, createdb, pgCtl };
}
