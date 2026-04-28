/**
 * pgConfig.ts
 *
 * Post-initdb configuration helpers for "hosted" (server) PostgreSQL instances.
 *
 * Called by NewInstanceScreen after `initDb` succeeds when the user chose
 * "Hosted / shared server" placement on Linux.
 *
 * Actions performed:
 *   1. postgresql.conf  — set listen_addresses = '*' so PG binds on all NICs,
 *                         not just the default loopback.
 *   2. pg_hba.conf      — append scram-sha-256 rules for IPv4 0.0.0.0/0 and
 *                         IPv6 ::/0 so remote clients can authenticate.
 *   3. Firewall         — attempt `ufw allow <port>/tcp`, fall back to
 *                         `firewall-cmd --add-port --permanent && --reload`.
 *                         Firewall failure is treated as a warning, not a
 *                         fatal error, because the user may be using iptables
 *                         directly or have no firewall at all.
 *
 * All paths and commands use explicit, whitelist-safe argument arrays —
 * never shell string interpolation — to prevent injection.
 */

import { spawn }    from 'child_process';
import * as fs      from 'fs';
import * as path    from 'path';

export interface PgConfigResult {
  ok:      boolean;
  message: string;
}

/**
 * Configure a newly-initialised data directory for hosted/server access.
 * Safe to call multiple times (idempotent for the conf edits).
 */
export async function configureHostedMode(
  dataDir: string,
  port:    number,
  onLine:  (line: string) => void,
): Promise<PgConfigResult> {
  // ── 1. postgresql.conf ─────────────────────────────────────────────────────
  const confPath = path.join(dataDir, 'postgresql.conf');
  try {
    let conf = fs.readFileSync(confPath, 'utf8');

    // The default initdb output contains a commented line:
    //   #listen_addresses = 'localhost'
    // We replace that (or any explicit existing setting) with '*'.
    if (/^#?\s*listen_addresses\s*=/m.test(conf)) {
      conf = conf.replace(
        /^#?\s*listen_addresses\s*=.*$/m,
        "listen_addresses = '*'    # pgmanager: hosted mode",
      );
    } else {
      conf += "\nlisten_addresses = '*'    # pgmanager: hosted mode\n";
    }

    fs.writeFileSync(confPath, conf, 'utf8');
    onLine("postgresql.conf: listen_addresses = '*'");
  } catch (err: any) {
    return { ok: false, message: `postgresql.conf update failed: ${String(err?.message ?? err)}` };
  }

  // ── 2. pg_hba.conf ─────────────────────────────────────────────────────────
  const hbaPath = path.join(dataDir, 'pg_hba.conf');
  try {
    let hba = fs.readFileSync(hbaPath, 'utf8');

    // Only append if the rules aren't already present (idempotent).
    if (!hba.includes('0.0.0.0/0')) {
      hba +=
        '\n# pgmanager: hosted mode — remote client authentication\n' +
        'host    all             all             0.0.0.0/0               scram-sha-256\n' +
        'host    all             all             ::/0                    scram-sha-256\n';
      fs.writeFileSync(hbaPath, hba, 'utf8');
      onLine('pg_hba.conf: scram-sha-256 rules added for 0.0.0.0/0 and ::/0');
    } else {
      onLine('pg_hba.conf: remote rules already present, skipping');
    }
  } catch (err: any) {
    return { ok: false, message: `pg_hba.conf update failed: ${String(err?.message ?? err)}` };
  }

  // ── 3. Firewall ─────────────────────────────────────────────────────────────
  // Non-fatal: a warning is logged but we do not abort the setup.
  const fwResult = await openFirewallPort(port, onLine);
  if (!fwResult.ok) {
    onLine(`Firewall: ${fwResult.message}`);
    onLine(`Firewall: remember to open port ${port}/tcp manually before connecting remotely`);
  }

  return { ok: true, message: 'Hosted network configuration complete' };
}

// ─── Firewall helpers ────────────────────────────────────────────────────────

async function openFirewallPort(
  port:   number,
  onLine: (line: string) => void,
): Promise<PgConfigResult> {
  // ufw
  if (await commandExists('ufw')) {
    onLine(`Firewall: ufw allow ${port}/tcp`);
    const code = await runCommand('ufw', ['allow', `${port}/tcp`], onLine);
    if (code === 0) {
      onLine(`Firewall: port ${port}/tcp opened via ufw`);
      return { ok: true, message: 'ufw rule added' };
    }
    onLine(`Firewall: ufw exited ${code}, trying firewall-cmd...`);
  }

  // firewalld
  if (await commandExists('firewall-cmd')) {
    onLine(`Firewall: firewall-cmd --add-port=${port}/tcp --permanent`);
    const c1 = await runCommand(
      'firewall-cmd', [`--add-port=${port}/tcp`, '--permanent'], onLine,
    );
    const c2 = await runCommand('firewall-cmd', ['--reload'], onLine);
    if (c1 === 0 && c2 === 0) {
      onLine(`Firewall: port ${port}/tcp opened via firewall-cmd`);
      return { ok: true, message: 'firewall-cmd rule added' };
    }
  }

  return {
    ok:      false,
    message: 'no supported firewall tool found (ufw / firewall-cmd) — open port manually',
  };
}

function commandExists(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const p = spawn('which', [cmd], { stdio: 'ignore' });
      p.on('exit',  code  => resolve(code === 0));
      p.on('error', ()    => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

function runCommand(
  bin:    string,
  args:   string[],
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise(resolve => {
    try {
      const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = (d: Buffer) =>
        d.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
      p.stdout?.on('data', handle);
      p.stderr?.on('data', handle);
      p.on('exit',  code  => resolve(code ?? 1));
      p.on('error', ()    => resolve(1));
    } catch {
      resolve(1);
    }
  });
}
