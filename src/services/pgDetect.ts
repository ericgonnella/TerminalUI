import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs   from 'fs';
import * as path from 'path';
import { binDirHasRequiredDlls, ensureRuntimeShim } from './pgRuntime';
import { installedMajors, managedBinDir } from './pgVersions';

const execFileAsync = promisify(execFile);

export interface PostgresInfo {
  /** Full path to pg_ctl. Empty string on Windows when managed via a service. */
  pgCtl:          string;
  psql:           string;
  initdb:         string;
  createdb:       string;
  version:        string;
  /** Windows service name (e.g. postgresql-x64-17) when pg_ctl is unavailable. */
  winServiceName?: string;
  /** Data directory extracted from the Windows service config. */
  winDataDir?:    string;
  /** On Windows: pgAdmin runtime dir prepended to PATH so PG binaries find libpq.dll. */
  winDllDir?:     string;
  /** On Windows: PGSHAREDIR for the self-contained runtime shim. */
  winShareDir?:   string;
}

// --- Windows helpers ----------------------------------------------------------

/**
 * On Windows the EDB installer puts libpq.dll (and SSL libs) inside the
 * pgAdmin 4 runtime directory rather than the main bin/ folder.  Locate it
 * so we can prepend it to PATH before spawning any PG binaries.
 */
function findWindowsDllDir(binDir: string): string | undefined {
  const installRoot   = path.dirname(binDir); // e.g. C:\Program Files\PostgreSQL\17
  const pgAdminRuntime = path.join(installRoot, 'pgAdmin 4', 'runtime');
  if (fs.existsSync(path.join(pgAdminRuntime, 'libpq.dll'))) return pgAdminRuntime;
  return undefined;
}

/** Return all candidate bin dirs under Program Files, newest version first. */
function windowsCandidateDirs(): string[] {
  const roots = [
    'C:\\Program Files\\PostgreSQL',
    'C:\\Program Files (x86)\\PostgreSQL',
  ];
  const dirs: { ver: number; dir: string }[] = [];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root)) {
        const binDir = path.join(root, entry, 'bin');
        if (fs.existsSync(binDir)) dirs.push({ ver: parseFloat(entry) || 0, dir: binDir });
      }
    } catch { /* root not found */ }
  }
  dirs.sort((a, b) => b.ver - a.ver);
  return dirs.map(d => d.dir);
}

interface WinSvcInfo {
  pgCtl:       string;  // may be '' if file does not exist on disk
  dataDir:     string;
  serviceName: string;
}

/** Try known EDB service name patterns (newest first). */
async function findWindowsService(): Promise<WinSvcInfo | null> {
  if (process.platform !== 'win32') return null;

  const candidates = [
    'postgresql-x64-17', 'postgresql-x64-16', 'postgresql-x64-15',
    'postgresql-x64-14', 'postgresql-x64-13', 'postgresql-x64-12',
    'postgresql-17', 'postgresql-16', 'postgresql-15',
  ];

  for (const serviceName of candidates) {
    try {
      const { stdout } = await execFileAsync('sc', ['qc', serviceName], { timeout: 4000 });

      // BINARY_PATH_NAME   : "C:\...\pg_ctl.exe" runservice -N "svcname" -D "C:\...\data" -w
      const bpMatch = stdout.match(/BINARY_PATH_NAME\s*:\s*(.*)/);
      if (!bpMatch) continue;

      const bpLine = bpMatch[1].trim();

      // Extract the executable path (quoted or unquoted)
      const quotedExe  = bpLine.match(/^"([^"]+\.exe)"/i);
      const unquotedExe = bpLine.match(/^([^\s]+\.exe)/i);
      const rawCtlPath = quotedExe ? quotedExe[1] : (unquotedExe ? unquotedExe[1] : '');

      // Extract -D "datadir"
      const dataDirMatch = bpLine.match(/-D\s+"([^"]+)"/);
      const dataDir = dataDirMatch ? dataDirMatch[1] : '';

      // Only use the extracted pg_ctl path if the binary actually exists
      const pgCtl = (rawCtlPath && fs.existsSync(rawCtlPath)) ? rawCtlPath : '';

      return { pgCtl, dataDir, serviceName };
    } catch { /* service not installed, try next */ }
  }

  return null;
}

// --- Cross-platform binary search ---------------------------------------------

/**
 * Check if a managed (self-contained) version is available and return its binaries.
 * Managed versions are always preferred because they are complete — no DLL issues.
 */
function managedBinaries(): { pgCtl: string; psql: string; initdb: string; createdb: string } | null {
  const majors = installedMajors(); // sorted newest first
  for (const major of majors) {
    const binDir = managedBinDir(major);
    if (!binDir) continue;
    const ext = process.platform === 'win32' ? '.exe' : '';
    const pgCtl    = path.join(binDir, `pg_ctl${ext}`);
    const psql     = path.join(binDir, `psql${ext}`);
    const initdb   = path.join(binDir, `initdb${ext}`);
    const createdb = path.join(binDir, `createdb${ext}`);
    if (fs.existsSync(psql) && fs.existsSync(initdb) && fs.existsSync(createdb)) {
      return {
        pgCtl:    fs.existsSync(pgCtl) ? pgCtl : '',
        psql,
        initdb,
        createdb,
      };
    }
  }
  return null;
}

async function findBinary(names: string[]): Promise<string | null> {
  // 1. PATH lookup
  for (const name of names) {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const { stdout } = await execFileAsync(cmd, [name]);
      const found = stdout.trim().split(/\r?\n/)[0];
      if (found) return found;
    } catch { /* not on PATH */ }
  }

  // 2. Windows: probe well-known PG installation directories
  if (process.platform === 'win32') {
    for (const dir of windowsCandidateDirs()) {
      for (const name of names) {
        const candidate = path.join(dir, `${name}.exe`);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  // 3. Linux: scan Debian/Ubuntu versioned layout /usr/lib/postgresql/<ver>/bin
  if (process.platform === 'linux') {
    const root = '/usr/lib/postgresql';
    try {
      const entries = fs.readdirSync(root)
        .map(n => ({ n, ver: parseFloat(n) || 0 }))
        .filter(e => e.ver > 0)
        .sort((a, b) => b.ver - a.ver);
      for (const { n } of entries) {
        for (const name of names) {
          const candidate = path.join(root, n, 'bin', name);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch { /* /usr/lib/postgresql not present */ }

    // 4. Linux: ask pg_config for its bindir (works for source/custom installs)
    try {
      const { stdout } = await execFileAsync('pg_config', ['--bindir']);
      const bindir = stdout.trim();
      if (bindir) {
        for (const name of names) {
          const candidate = path.join(bindir, name);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch { /* pg_config not installed */ }
  }

  return null;
}

async function getVersion(psqlPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(psqlPath, ['--version']);
    const match = stdout.match(/(\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

// --- Public API ---------------------------------------------------------------

/**
 * Detect PostgreSQL binaries.
 * psql, initdb, and createdb are required.
 * pg_ctl is optional on Windows � a Windows service is used as fallback.
 * Returns null only if the required binaries cannot be found at all.
 */
export async function detectPostgres(): Promise<PostgresInfo | null> {
  // Prefer managed (self-contained portable) versions — they are always complete.
  const managed = managedBinaries();
  if (managed) {
    const version = await getVersion(managed.psql);
    return {
      pgCtl:    managed.pgCtl,
      psql:     managed.psql,
      initdb:   managed.initdb,
      createdb: managed.createdb,
      version,
    };
  }

  // Fall back to system-installed binaries.
  const [pgCtlFound, psql, initdb, createdb] = await Promise.all([
    findBinary(['pg_ctl']),
    findBinary(['psql']),
    findBinary(['initdb']),
    findBinary(['createdb']),
  ]);

  if (!psql || !initdb || !createdb) return null;

  let pgCtl = pgCtlFound ?? '';
  let winServiceName: string | undefined;
  let winDataDir:     string | undefined;
  let winDllDir:      string | undefined;
  let winShareDir:    string | undefined;
  let resolvedPsql     = psql;
  let resolvedInitdb   = initdb;
  let resolvedCreatedb = createdb;

  if (process.platform === 'win32') {
    // Locate the pgAdmin 4 runtime dir that holds libpq.dll and SSL libs.
    winDllDir = findWindowsDllDir(path.dirname(psql));
    if (winDllDir) {
      // Prepend once so every subsequent execFileAsync / spawn call inherits it.
      process.env.PATH = `${winDllDir};${process.env.PATH ?? ''}`;
    }

    if (!pgCtl) {
      const svc = await findWindowsService();
      if (svc) {
        pgCtl          = svc.pgCtl;       // '' if file not on disk
        winServiceName = svc.serviceName;
        winDataDir     = svc.dataDir;
      }
    }

    // If the install's bin dir is missing core DLLs, build a self-contained
    // runtime shim so Windows' DLL loader finds everything next to the EXE.
    // We check the dir containing `initdb` specifically — `psql` may have been
    // resolved from a different location (e.g. pgAdmin 4\runtime which already
    // has libpq.dll), but the real bin/ that holds initdb is what must load
    // DLLs, and it's often the incomplete one.
    const originalBinDir = path.dirname(initdb);
    if (!binDirHasRequiredDlls(originalBinDir)) {
      const ver = (await getVersion(psql));
      const extraDllDirs = winDllDir ? [winDllDir] : [];
      const shim = ensureRuntimeShim(originalBinDir, ver, extraDllDirs);
      if (shim) {
        resolvedPsql     = shim.psql;
        resolvedInitdb   = shim.initdb;
        resolvedCreatedb = shim.createdb;
        if (shim.pgCtl && !pgCtl) pgCtl = shim.pgCtl;
        winShareDir = shim.shareDir;
        // initdb / psql / createdb look for templates and locale files via
        // PGSHAREDIR.  Our shim lives outside the original install, so we
        // MUST point them back at the original share/ dir.
        if (fs.existsSync(shim.shareDir)) {
          process.env.PGSHAREDIR = shim.shareDir;
        }
      }
    }
  }

  const version = await getVersion(resolvedPsql);
  return {
    pgCtl,
    psql:     resolvedPsql,
    initdb:   resolvedInitdb,
    createdb: resolvedCreatedb,
    version,
    winServiceName,
    winDataDir,
    winDllDir,
    winShareDir,
  };
}
