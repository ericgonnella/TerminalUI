/**
 * Guided setup for hosted PostgreSQL instances.
 *
 * Hosted instances live on a remote VPS that this process cannot touch
 * directly (we don't ask for SSH credentials by default — that's a much
 * bigger security boundary than we want to cross). Instead we generate
 * a perfectly-tailored bash script the user runs once on the VPS via
 * SSH, then verify connectivity from this machine.
 *
 * The script implements the canonical PostgreSQL external-access recipe:
 *   1. listen_addresses = '*' in postgresql.conf
 *   2. host all <user> <cidr> scram-sha-256  in pg_hba.conf
 *   3. ufw / firewall-cmd allow <port>/tcp
 *   4. systemctl reload postgresql (or restart if listen_addresses flipped)
 *
 * The generated block in pg_hba.conf is fenced with a unique tag so
 * subsequent runs replace only our rules and never touch user-managed
 * lines.
 */

import * as net from 'net';
import * as https from 'https';
import * as dns from 'dns';
import { validateAllowEntry } from './remoteAccess';
import type { Instance } from '../types';

// ─── Public-IP detection ─────────────────────────────────────────────────────

/**
 * Best-effort public-IP detection. We use ipify, a long-lived free
 * service that returns just the caller's IP as plain text. Failure is
 * non-fatal — the wizard simply asks the user to type their IP.
 */
export async function detectClientPublicIp(timeoutMs = 4000): Promise<string | null> {
  return new Promise(resolve => {
    let done = false;
    const settle = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = https.get('https://api.ipify.org', { timeout: timeoutMs }, res => {
        if (res.statusCode !== 200) { res.resume(); settle(null); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; if (body.length > 64) req.destroy(); });
        res.on('end', () => {
          const ip = body.trim();
          // Only accept a plain IPv4/IPv6 literal — never echo arbitrary content.
          if (/^[0-9.]{7,15}$/.test(ip) || /^[0-9a-f:]{2,45}$/i.test(ip)) settle(ip);
          else settle(null);
        });
      });
      req.on('timeout', () => { req.destroy(); settle(null); });
      req.on('error', () => settle(null));
    } catch {
      settle(null);
    }
  });
}

// ─── TCP / DB reachability probe ─────────────────────────────────────────────

export interface ProbeResult {
  reachable: boolean;
  /** 'ok' | 'timeout' | 'refused' | 'unreachable' | 'dns' | 'other' */
  code: string;
  message: string;
  durationMs: number;
}

/** Pure TCP-handshake probe — no auth, no SSL, no payload. */
export async function probeTcp(host: string, port: number, timeoutMs = 6000): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise(resolve => {
    let settled = false;
    const finish = (r: Omit<ProbeResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); finish({ reachable: true, code: 'ok', message: 'TCP handshake succeeded.' }); });
    sock.once('timeout', () => { sock.destroy(); finish({ reachable: false, code: 'timeout', message: `No response within ${timeoutMs}ms — packets are being dropped (firewall / security group / listen_addresses).` }); });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      sock.destroy();
      const code = err.code ?? 'OTHER';
      let kind = 'other';
      let msg = err.message;
      if (code === 'ECONNREFUSED')      { kind = 'refused';     msg = 'Connection refused — host is reachable but nothing is listening on that port.'; }
      else if (code === 'EHOSTUNREACH') { kind = 'unreachable'; msg = 'Host unreachable — routing problem or host is offline.'; }
      else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') { kind = 'dns'; msg = 'DNS lookup failed for host.'; }
      else if (code === 'ETIMEDOUT')    { kind = 'timeout';    msg = 'Connection timed out (firewall is silently dropping packets).'; }
      finish({ reachable: false, code: kind, message: msg });
    });
    sock.connect(port, host);
  });
}

/** If the user gave us a hostname rather than an IP, try resolving it first
 *  so error messages are clearer. Returns the literal address used. */
export async function resolveHostIfNeeded(host: string): Promise<{ host: string; resolved: string | null }> {
  if (/^[0-9.]+$/.test(host) || /^\[?[0-9a-f:]+\]?$/i.test(host)) return { host, resolved: null };
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    return { host, resolved: addrs.length > 0 ? (addrs[0]?.address ?? null) : null };
  } catch {
    return { host, resolved: null };
  }
}

// ─── Script generation ──────────────────────────────────────────────────────

const HBA_TAG_PREFIX = '# BEGIN/END pgmanager-hosted-setup';

function shQuote(v: string): string {
  // Wrap in single quotes and escape any single quotes by closing/opening.
  return `'${v.replace(/'/g, `'"'"'`)}'`;
}

function validateAllowList(entries: string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of entries) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const v = validateAllowEntry(trimmed);
    if (!v.ok || !v.value) throw new Error(`Invalid allow-list entry: ${raw} — ${v.reason ?? 'rejected'}`);
    cleaned.push(v.value.value);
  }
  if (cleaned.length === 0) throw new Error('At least one IP, CIDR or domain is required.');
  return cleaned;
}

export interface BuildScriptOpts {
  /** Listening port we'll open in the firewall and reload postgres on. */
  port:        number;
  /** Role the wizard will scope the host-rule to. 'all' means every role. */
  superuser:   string;
  /** IP / CIDR / hostname entries the script should add to pg_hba.conf. */
  allowList:   string[];
  /** Auth method for the new pg_hba lines — scram-sha-256 is recommended. */
  authMethod?: 'scram-sha-256' | 'md5';
  /** Optional instance id, embedded in the tag for safe re-runs. */
  instanceId?: string;
}

export interface BuiltScript {
  /** The bash script body (no shebang interpolated values). */
  script:    string;
  /** A one-line `ssh ... <<'PGMSETUP' ... PGMSETUP` you can copy-paste. */
  oneLiner:  (sshTarget: string) => string;
  allowList: string[];
}

/**
 * Build the full bash script. The script is *idempotent* — running it
 * twice produces the same final state, and it never appends duplicate
 * pg_hba lines because it removes our previous tagged block first.
 */
export function buildSetupScript(opts: BuildScriptOpts): BuiltScript {
  const port      = opts.port;
  const superuser = opts.superuser;
  const auth      = opts.authMethod ?? 'scram-sha-256';
  const tagId     = (opts.instanceId ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanList = validateAllowList(opts.allowList);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid port.');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(superuser) || superuser.length > 63) throw new Error('Invalid superuser name.');

  const beginTag = `${HBA_TAG_PREFIX}-BEGIN ${tagId}`;
  const endTag   = `${HBA_TAG_PREFIX}-END ${tagId}`;

  // Each CIDR must be on its own line in pg_hba.conf.  Joining with '\n' then
  // using printf '%s' would embed a literal backslash-n rather than a real newline,
  // producing one invalid line.  Generate a separate printf call per entry instead.
  const hbaLinesBash = cleanList
    .map(v => `  printf 'host    all    ${superuser === 'all' ? 'all' : superuser}    ${v}    ${auth}\\n'`)
    .join('\n');

  // NB: every interpolated value is a literal we control or has been
  // strictly validated, so single-quoting is sufficient.
  const script =
`#!/usr/bin/env bash
# pgmanager hosted-setup — idempotent
set -euo pipefail

PGPORT=${port}
PGUSER=${shQuote(superuser)}
TAG_ID=${shQuote(tagId)}
AUTH=${shQuote(auth)}

if [ "$(id -u)" -ne 0 ]; then
  echo "==> Re-executing under sudo so we can edit /etc/postgresql and reload the service"
  # Re-exec only works when $0 is an actual script file (local run via pgmanager).
  # The SSH one-liner uses 'sudo bash -s' so it already arrives here as root.
  if [ -f "$0" ]; then
    exec sudo -E bash "$0" "$@"
  fi
  echo "ERROR: not running as root — use the SSH one-liner (sudo bash -s) or run pgmanager as root." >&2
  exit 1
fi

VER=""
CLU=""

echo "==> Detecting PostgreSQL config locations"
PGCONF="$(sudo -u postgres psql -tAc 'SHOW config_file;' 2>/dev/null || true)"
PGHBA="$(sudo -u postgres psql -tAc 'SHOW hba_file;'    2>/dev/null || true)"
if [ -z "$PGCONF" ] || [ -z "$PGHBA" ]; then
  # Fallback: use pg_lsclusters (Debian/Ubuntu) or guess the latest version dir.
  if command -v pg_lsclusters >/dev/null 2>&1; then
    LINE="$(pg_lsclusters -h | awk '$3 == '"$PGPORT"' { print $1, $2; exit }')"
    if [ -n "$LINE" ]; then
      VER="\${LINE%% *}"; CLU="\${LINE##* }"
      PGCONF="/etc/postgresql/$VER/$CLU/postgresql.conf"
      PGHBA="/etc/postgresql/$VER/$CLU/pg_hba.conf"
    fi
  fi
fi
if [ -z "$PGCONF" ] || [ ! -f "$PGCONF" ]; then echo "ERROR: cannot locate postgresql.conf" >&2; exit 2; fi
if [ -z "$PGHBA"  ] || [ ! -f "$PGHBA"  ]; then echo "ERROR: cannot locate pg_hba.conf"     >&2; exit 2; fi
echo "    postgresql.conf = $PGCONF"
echo "    pg_hba.conf     = $PGHBA"

echo "==> 1/4 listen_addresses = '*'"
LISTEN_NEEDS_RESTART=0
if grep -Eq "^[[:space:]]*listen_addresses[[:space:]]*=" "$PGCONF"; then
  CUR="$(grep -E "^[[:space:]]*listen_addresses[[:space:]]*=" "$PGCONF" | tail -n1)"
  if ! echo "$CUR" | grep -q "'\\*'"; then
    cp -a "$PGCONF" "$PGCONF.pgmanager.bak.$(date +%s)"
    sed -ri "s|^[[:space:]]*listen_addresses[[:space:]]*=.*|listen_addresses = '*'|g" "$PGCONF"
    LISTEN_NEEDS_RESTART=1
  else
    echo "    already set"
  fi
else
  cp -a "$PGCONF" "$PGCONF.pgmanager.bak.$(date +%s)"
  echo "listen_addresses = '*'" >> "$PGCONF"
  LISTEN_NEEDS_RESTART=1
fi

echo "==> 2/4 pg_hba.conf — write tagged block"
cp -a "$PGHBA" "$PGHBA.pgmanager.bak.$(date +%s)"
# Remove any previous block we own (between our tags) — tolerate absence.
TMP_HBA="$(mktemp)"
awk -v B="${beginTag}" -v E="${endTag}" '
  $0 == B { skip=1; next }
  $0 == E { skip=0; next }
  !skip
' "$PGHBA" > "$TMP_HBA"
{
  cat "$TMP_HBA"
  printf '\\n%s\\n' "${beginTag}"
${hbaLinesBash}
  printf '%s\\n' "${endTag}"
} > "$PGHBA"
rm -f "$TMP_HBA"

echo "==> 3/4 Open firewall port $PGPORT/tcp"
if   command -v ufw          >/dev/null 2>&1; then ufw allow "$PGPORT"/tcp || true
elif command -v firewall-cmd >/dev/null 2>&1; then firewall-cmd --permanent --add-port="$PGPORT"/tcp; firewall-cmd --reload
elif command -v iptables     >/dev/null 2>&1; then iptables -C INPUT -p tcp --dport "$PGPORT" -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport "$PGPORT" -j ACCEPT
else echo "    (no supported firewall found — skipping)"; fi

echo "==> 4/4 Reload PostgreSQL"
# Discover the actual service name — systemctl does not expand globs, so
# 'postgresql@*-main' would silently fail on versioned Debian/Ubuntu installs.
_pg_svc_action() {
  local ACT="$1"
  if command -v pg_ctlcluster >/dev/null 2>&1 && [ -n "$VER" ] && [ -n "$CLU" ]; then
    pg_ctlcluster "$VER" "$CLU" "$ACT" || true
  elif command -v systemctl >/dev/null 2>&1; then
    SVC="$(systemctl list-units --type=service --all --no-legend 2>/dev/null | awk '/postgresql/{gsub(/\\.service$/,"",$1); print $1; exit}')"
    [ -z "$SVC" ] && SVC="postgresql"
    systemctl "$ACT" "$SVC" || true
  elif command -v service >/dev/null 2>&1; then
    service postgresql "$ACT" || true
  else
    echo "    WARNING: no service manager found — restart PostgreSQL manually." >&2
  fi
}
if [ "$LISTEN_NEEDS_RESTART" -eq 1 ]; then _pg_svc_action restart
else _pg_svc_action reload
fi

echo
echo "OK — pgmanager hosted setup complete. Try connecting from your client now."
`;

  const oneLiner = (sshTarget: string) => {
    if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.\-:[\]]+$/.test(sshTarget)) {
      // Still return something printable but flag the bad target.
      return `# Invalid SSH target — expected user@host\n# (got: ${sshTarget})`;
    }
    // We deliberately don't escape inside the heredoc — the heredoc terminator
    // PGMSETUP is quoted ('PGMSETUP') so the shell does NO substitution, which
    // means the script body travels literally to the remote bash.
    // 'sudo bash -s' ensures the script runs as root from the start, avoiding
    // the $0-is-not-a-file re-exec problem that occurs with plain 'bash -s'.
    return `ssh ${sshTarget} 'sudo bash -s' <<'PGMSETUP'\n${script}PGMSETUP\n`;
  };

  return { script, oneLiner, allowList: cleanList };
}

/** Convenience wrapper that takes an Instance and an allow-list. */
export function buildSetupScriptForInstance(instance: Instance, allowList: string[]): BuiltScript {
  return buildSetupScript({
    port:       instance.port,
    superuser:  instance.superuser,
    allowList,
    instanceId: instance.id,
  });
}

// ─── Cloudflare Tunnel — guided alternative for upstream-firewalled VPSs ────
//
// When the cloud provider (BuyVM, Hetzner ingress filter, etc.) silently
// drops inbound packets on the Postgres port, opening ufw on the VPS
// alone won't help. A Cloudflare Tunnel solves it by reversing direction:
// `cloudflared` on the VPS opens a long-lived OUTBOUND HTTPS connection to
// Cloudflare's edge, and Cloudflare brokers traffic from clients into it.
// No inbound ports needed at all.
//
// IMPORTANT: TCP-mode tunnels (which Postgres needs) require the *client*
// to also run `cloudflared access tcp --hostname pg.your.domain --url
// tcp://localhost:5432` to terminate the tunnel locally. This is fine for
// laptop / backend clients, but Netlify Functions cannot run `cloudflared`
// — for serverless front-ends use a managed pooler (Supabase, Neon) or
// open the upstream firewall and use 0.0.0.0/0 + scram-sha-256.

const TUNNEL_HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export interface BuildTunnelOpts {
  /** Local Postgres port on the VPS, e.g. 5434. */
  port:        number;
  /** FQDN to expose the tunnel under, e.g. 'pg.example.com'. Must be
   *  on a domain you've added to Cloudflare (any plan). */
  hostname:    string;
  /** Stable name for the tunnel resource on Cloudflare. We sanitise. */
  tunnelName?: string;
  /** Optional instance id, embedded in the default tunnel name. */
  instanceId?: string;
}

export interface BuiltTunnelScript {
  serverScript: string;
  clientCommand: string;
  hostname: string;
  tunnelName: string;
}

export function buildCloudflareTunnelScript(opts: BuildTunnelOpts): BuiltTunnelScript {
  const port = opts.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid port.');
  }
  const hostname = opts.hostname.trim().toLowerCase();
  if (!TUNNEL_HOSTNAME_RE.test(hostname)) {
    throw new Error('Hostname must be a valid FQDN (e.g. pg.example.com).');
  }
  const rawName = opts.tunnelName ?? `pgmanager-${opts.instanceId ?? 'default'}`;
  const tunnelName = rawName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'pgmanager';

  const serverScript =
`#!/usr/bin/env bash
# pgmanager — Cloudflare Tunnel setup (server side, run on the VPS)
# Idempotent: safe to re-run. Requires you to have logged in to a
# Cloudflare account that owns the parent domain of: ${hostname}
set -euo pipefail

PG_LOCAL_PORT=${port}
TUNNEL_NAME=${shQuote(tunnelName)}
HOSTNAME=${shQuote(hostname)}

if [ "$(id -u)" -ne 0 ]; then
  echo "==> Re-executing under sudo so we can install cloudflared and a systemd service"
  if [ -f "$0" ]; then
    exec sudo -E bash "$0" "$@"
  fi
  echo "ERROR: not running as root — use the SSH one-liner (sudo bash -s) or run as root." >&2
  exit 1
fi

# 1. Install cloudflared if missing.
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "==> Installing cloudflared"
  ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$ARCH" in
    amd64|x86_64) PKG=cloudflared-linux-amd64.deb ;;
    arm64|aarch64) PKG=cloudflared-linux-arm64.deb ;;
    armhf|armv7l) PKG=cloudflared-linux-arm.deb ;;
    *) echo "Unsupported arch: $ARCH" >&2; exit 2 ;;
  esac
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/$PKG" -o "$TMP/$PKG"
  if command -v dpkg >/dev/null 2>&1; then
    dpkg -i "$TMP/$PKG" || apt-get install -fy
  else
    # Fallback: drop the static binary
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
  fi
  rm -rf "$TMP"
fi

# 2. Authenticate (interactive — opens a browser link).
if [ ! -f /root/.cloudflared/cert.pem ] && [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "==> One-time browser login. Open the URL it prints and pick the parent zone for $HOSTNAME"
  cloudflared tunnel login
fi

# 3. Create the tunnel if it doesn't exist.
EXISTING="$(cloudflared tunnel list -o json 2>/dev/null | python3 -c 'import sys,json; data=json.load(sys.stdin); name=sys.argv[1]; print(next((t["id"] for t in data if t["name"]==name), ""))' "$TUNNEL_NAME" || true)"
if [ -z "$EXISTING" ]; then
  echo "==> Creating tunnel: $TUNNEL_NAME"
  cloudflared tunnel create "$TUNNEL_NAME"
  EXISTING="$(cloudflared tunnel list -o json | python3 -c 'import sys,json; data=json.load(sys.stdin); name=sys.argv[1]; print(next((t["id"] for t in data if t["name"]==name), ""))' "$TUNNEL_NAME")"
fi
if [ -z "$EXISTING" ]; then echo "ERROR: failed to create or look up tunnel" >&2; exit 3; fi
TUNNEL_ID="$EXISTING"
echo "    tunnel id: $TUNNEL_ID"

# 4. DNS route (Cloudflare creates the CNAME for us).
echo "==> Routing $HOSTNAME -> tunnel"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || true

# 5. Write the per-tunnel config so the service forwards TCP to localhost:PG_LOCAL_PORT.
mkdir -p /etc/cloudflared
CRED_SRC="/root/.cloudflared/$TUNNEL_ID.json"
[ -f "$CRED_SRC" ] || CRED_SRC="$HOME/.cloudflared/$TUNNEL_ID.json"
cp -f "$CRED_SRC" "/etc/cloudflared/$TUNNEL_ID.json"
cat > /etc/cloudflared/config.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: /etc/cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $HOSTNAME
    service: tcp://localhost:$PG_LOCAL_PORT
  - service: http_status:404
EOF

# 6. Install + start a systemd service that runs as a daemon.
if ! systemctl list-unit-files | grep -q '^cloudflared\\.service'; then
  cloudflared service install || true
fi
systemctl daemon-reload || true
systemctl enable cloudflared 2>/dev/null || true
systemctl restart cloudflared

echo
echo "OK — tunnel up. Test from any machine that has cloudflared installed:"
echo
echo "  cloudflared access tcp --hostname $HOSTNAME --url tcp://localhost:$PG_LOCAL_PORT"
echo "  psql -h 127.0.0.1 -p $PG_LOCAL_PORT -U <user> -d postgres"
`;

  // The "client side" is what the user runs on their laptop / app server
  // to terminate the TCP tunnel locally. They then connect psql to
  // 127.0.0.1:<port>. Netlify functions cannot run this — see header note.
  const clientCommand =
    `cloudflared access tcp --hostname ${hostname} --url tcp://localhost:${port}`;

  return { serverScript, clientCommand, hostname, tunnelName };
}

export function buildCloudflareTunnelForInstance(instance: Instance, hostname: string): BuiltTunnelScript {
  return buildCloudflareTunnelScript({
    port:       instance.port,
    hostname,
    instanceId: instance.id,
  });
}
