import React, { useEffect, useState, useCallback } from 'react';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import {
  detectClientPublicIp,
  probeTcp,
  resolveHostIfNeeded,
  buildSetupScriptForInstance,
  type BuiltScript,
  type ProbeResult,
} from '../services/hostedSetup';
import { validateAllowEntry, withDirectApplied } from '../services/remoteAccess';
import { Keybindings } from '../components/Keybindings';
import type { Navigation } from '../hooks/useNavigation';
import type { InstancesState } from '../hooks/useInstances';
import type { Instance, RemoteAccessConfig } from '../types';
import { mutedColor } from '../theme';

interface Props {
  nav:       Navigation;
  instances: InstancesState;
  instance:  Instance;
}

type Step =
  | 'welcome'
  | 'allow-list'
  | 'add-entry'
  | 'review'
  | 'await-run'
  | 'testing'
  | 'success'
  | 'failure';

/**
 * Guided setup for a HOSTED PostgreSQL instance.
 *
 * The instance lives on a remote VPS we cannot edit directly, so this
 * screen produces a tailored, idempotent shell script the user runs once
 * over SSH, then verifies the connection from this machine. On success
 * the IPs/CIDRs are persisted into instance.remoteAccess.directCidrs so
 * the [I] info panel surfaces the active configuration.
 */
export const HostedSetupScreen: React.FC<Props> = ({ nav, instances, instance: initialInstance }) => {
  const [instance, setInstance] = useState<Instance>(initialInstance);

  const [step, setStep] = useState<Step>('welcome');

  // Public-IP detection
  const [detecting,   setDetecting]   = useState(true);
  const [detectedIp,  setDetectedIp]  = useState<string | null>(null);

  // Allow-list state — pre-seeded with the user's public IP once detected.
  const [allowList, setAllowList] = useState<string[]>([]);
  const [entryInput, setEntryInput] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);

  // Built script + probe results
  const [built,     setBuilt]     = useState<BuiltScript | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [probe,  setProbe]  = useState<ProbeResult | null>(null);
  const [resolved, setResolved] = useState<string | null>(null);

  // Detect public IP once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ip = await detectClientPublicIp();
      if (cancelled) return;
      setDetectedIp(ip);
      setDetecting(false);
      if (ip) {
        // Convert to /32 (or /128) so it's a valid CIDR — pg_hba accepts both.
        const suffix = ip.includes(':') ? '/128' : '/32';
        setAllowList(prev => prev.length === 0 ? [`${ip}${suffix}`] : prev);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const persistApplied = useCallback((cidrs: string[]) => {
    const nextCfg: RemoteAccessConfig = withDirectApplied(instance.remoteAccess, cidrs, true);
    const next: Instance = { ...instance, remoteAccess: nextCfg };
    setInstance(next);
    instances.updateInstance(next);
  }, [instance, instances]);

  const saveScript = useCallback(() => {
    if (!built) return;
    try {
      const fname = `pgmsetup-${instance.id}.sh`;
      const fpath = path.join(os.tmpdir(), fname);
      fs.writeFileSync(fpath, built.script, 'utf8');
      setSavedPath(fpath);
    } catch (err: any) {
      setSavedPath(`(error saving: ${String(err?.message ?? err)})`);
    }
  }, [built, instance.id]);

  const buildAndShow = useCallback(() => {
    try {
      const b = buildSetupScriptForInstance(instance, allowList);
      setBuilt(b);
      setStep('review');
    } catch (err: any) {
      setEntryError(String(err?.message ?? err));
    }
  }, [instance, allowList]);

  const runTest = useCallback(async () => {
    setStep('testing');
    setProbe(null);
    const host = instance.host ?? '127.0.0.1';
    const r = await resolveHostIfNeeded(host);
    setResolved(r.resolved);
    const result = await probeTcp(host, instance.port);
    setProbe(result);
    if (result.reachable) {
      persistApplied(allowList);
      setStep('success');
    } else {
      setStep('failure');
    }
  }, [instance, allowList, persistApplied]);

  // Keyboard router
  useInput((input, key) => {
    if (step === 'welcome') {
      if (key.return) { setStep('allow-list'); return; }
      if (key.escape) { nav.pop(); return; }
      return;
    }
    if (step === 'allow-list') {
      if (input === 'a' || input === 'A') { setEntryInput(''); setEntryError(null); setStep('add-entry'); return; }
      if (input === 'r' || input === 'R') {
        // Remove last
        setAllowList(prev => prev.slice(0, -1));
        return;
      }
      if (key.return && allowList.length > 0) { buildAndShow(); return; }
      if (key.escape) { nav.pop(); return; }
      return;
    }
    if (step === 'review') {
      if (input === 's' || input === 'S') { saveScript(); return; }
      if (key.return) { setStep('await-run'); return; }
      if (key.escape) { setStep('allow-list'); return; }
      return;
    }
    if (step === 'await-run') {
      if (key.return) { void runTest(); return; }
      if (key.escape) { setStep('review'); return; }
      return;
    }
    // Block navigation while tests are running
    if (step === 'testing') return;
    if (step === 'success') {
      if (key.return || key.escape) { nav.pop(); return; }
      return;
    }
    if (step === 'failure') {
      if (input === 'r' || input === 'R' || key.return) { void runTest(); return; }
      if (key.escape) { setStep('review'); return; }
      return;
    }
    if (step === 'add-entry' && key.escape) { setStep('allow-list'); return; }
  });

  const handleEntrySubmit = useCallback((v: string) => {
    const c = validateAllowEntry(v);
    if (!c.ok || !c.value) { setEntryError(c.reason ?? 'Invalid entry'); return; }
    setEntryError(null);
    setAllowList(prev => prev.includes(c.value!.value) ? prev : [...prev, c.value!.value]);
    setEntryInput('');
    setStep('allow-list');
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────

  const host = instance.host ?? '127.0.0.1';

  if (step === 'welcome') {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="magenta" paddingX={2} flexDirection="column">
          <Text color="magenta" bold>{'Guided Hosted Setup'}</Text>
          <Text color={mutedColor}>{'─'.repeat(56)}</Text>
          <Text color="white">
            {'This wizard configures '}
            <Text color="cyan" bold>{instance.name}</Text>
            <Text>{` (${host}:${instance.port}) for external connections.`}</Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={mutedColor}>{'It will:'}</Text>
            <Text color="white">{'  1. Detect your public IP and let you add more (IP / CIDR / domain)'}</Text>
            <Text color="white">{"  2. Generate a tailored bash script (listen_addresses='*', pg_hba, firewall, reload)"}</Text>
            <Text color="white">{'  3. Give you a copy-paste SSH one-liner to run on the VPS'}</Text>
            <Text color="white">{'  4. Test the live TCP connection and persist the result'}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow" bold>{'⚠  Important — Netlify / serverless apps'}</Text>
            <Text color={mutedColor}>{'   Netlify Functions egress from a wide, dynamic AWS IP range, so a tight'}</Text>
            <Text color={mutedColor}>{'   CIDR allow-list will not reliably reach your DB. For production with'}</Text>
            <Text color={mutedColor}>{'   eric-weightloss.netlify.app or similar, use one of:'}</Text>
            <Text color={mutedColor}>{'     • A managed pooler / proxy in front (Supabase pooler, PgBouncer + Cloudflare Tunnel, Neon)'}</Text>
            <Text color={mutedColor}>{'     • Or 0.0.0.0/0 + scram-sha-256 + a strong password (TLS recommended)'}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="green" bold>{'[Enter] '}</Text><Text color="white">{'continue   '}</Text>
            <Text color={mutedColor} bold>{'[Esc] '}</Text><Text color={mutedColor}>{'cancel'}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (step === 'allow-list') {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
          <Text color="cyan" bold>{'Step 1 of 4 — Who is allowed to connect?'}</Text>
          <Text color={mutedColor}>{'─'.repeat(56)}</Text>
          {detecting && (
            <Box>
              <Text color="yellow"><Spinner type="dots" /></Text>
              <Text color={mutedColor}>{'  Detecting your public IP…'}</Text>
            </Box>
          )}
          {!detecting && detectedIp && (
            <Text color="green">{`✓ Detected your public IP: ${detectedIp}`}</Text>
          )}
          {!detecting && !detectedIp && (
            <Text color="yellow">{'⚠  Could not auto-detect public IP — add an entry manually with [A].'}</Text>
          )}
          <Box marginTop={1} flexDirection="column">
            <Text color={mutedColor}>{'Allow-list entries:'}</Text>
            {allowList.length === 0 && (
              <Text color="red">{'  (empty — at least one entry required)'}</Text>
            )}
            {allowList.map((v, i) => (
              <Box key={`${i}-${v}`}>
                <Text color="cyan">{'  • '}</Text>
                <Text color="white">{v}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color="green" bold>{'[A] '}</Text><Text color="white">{'add another   '}</Text>
            <Text color="yellow" bold>{'[R] '}</Text><Text color="white">{'remove last   '}</Text>
            <Text color="green" bold>{'[Enter] '}</Text><Text color="white">{'continue   '}</Text>
            <Text color={mutedColor} bold>{'[Esc] '}</Text><Text color={mutedColor}>{'cancel'}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (step === 'add-entry') {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
          <Text color="cyan" bold>{'Add allow-list entry'}</Text>
          <Text color={mutedColor}>{'─'.repeat(56)}</Text>
          <Text color={mutedColor}>{'Examples: 203.0.113.5 — 198.51.100.0/24 — home.example.com — 2001:db8::/32'}</Text>
          <Box marginTop={1}>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={entryInput}
              onChange={setEntryInput}
              onSubmit={handleEntrySubmit}
              placeholder="203.0.113.5  or  home.example.com"
            />
          </Box>
          {!!entryError && (
            <Text color="red">{`  ${entryError}`}</Text>
          )}
          <Text color={mutedColor}>{'[Enter] add   [Esc] back'}</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'review' && built) {
    const target = `${instance.superuser}@${host}`;
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
          <Text color="cyan" bold>{'Step 2 of 4 — Run this on your VPS'}</Text>
          <Text color={mutedColor}>{'─'.repeat(56)}</Text>
          <Text color="white">{'Open a terminal on a machine with SSH access to the VPS and paste:'}</Text>
          <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor={mutedColor} paddingX={1}>
            <Text color="green">{`ssh ${target} 'bash -s' <<'PGMSETUP'`}</Text>
            {built.script.split('\n').slice(0, 60).map((line, i) => (
              <Text key={i} color={mutedColor}>{line}</Text>
            ))}
            {built.script.split('\n').length > 60 && (
              <Text color="yellow">{`  … (${built.script.split('\n').length - 60} more lines — full script is generated, copy from your terminal scroll-back if needed) …`}</Text>
            )}
            <Text color="green">{'PGMSETUP'}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={mutedColor}>{'What this does (idempotent — safe to re-run):'}</Text>
            <Text color="white">{"  1. listen_addresses = '*'   (postgresql.conf)"}</Text>
            <Text color="white">{`  2. host all ${instance.superuser} <each-entry> scram-sha-256   (pg_hba.conf)`}</Text>
            <Text color="white">{`  3. ufw / firewall-cmd allow ${instance.port}/tcp   (firewall)`}</Text>
            <Text color="white">{'  4. systemctl reload postgresql   (or restart if listen flipped)'}</Text>
          </Box>
          {!!savedPath && (
            <Box marginTop={1}>
              <Text color="green">{`✓ Script saved → ${savedPath}`}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color="cyan" bold>{'[S] '}</Text><Text color="white">{'save script to file   '}</Text>
            <Text color="green" bold>{'[Enter] '}</Text><Text color="white">{'I have run it — go to test   '}</Text>
            <Text color={mutedColor} bold>{'[Esc] '}</Text><Text color={mutedColor}>{'edit allow-list'}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (step === 'await-run') {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
          <Text color="cyan" bold>{'Step 3 of 4 — Test connection'}</Text>
          <Text color={mutedColor}>{'─'.repeat(56)}</Text>
          <Text color="white">
            {'Press '}<Text color="green" bold>{'[Enter]'}</Text>
            {` to probe TCP ${host}:${instance.port} from this machine.`}
          </Text>
          <Text color={mutedColor}>{'  [Esc] back to review'}</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'testing') {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
          <Box>
            <Text color="yellow"><Spinner type="dots" /></Text>
            <Text color={mutedColor}>{`  Probing ${host}:${instance.port}…`}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (step === 'success' && probe) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="green" paddingX={2} flexDirection="column">
          <Text color="green" bold>{'✓  Step 4 of 4 — Connection successful'}</Text>
          <Text color={mutedColor}>{'─'.repeat(56)}</Text>
          <Text color="white">{`TCP handshake on ${host}:${instance.port} took ${probe.durationMs}ms.`}</Text>
          {!!resolved && <Text color={mutedColor}>{`  Resolved ${host} → ${resolved}`}</Text>}
          <Box marginTop={1} flexDirection="column">
            <Text color={mutedColor}>{'Next — verify auth from a real psql client:'}</Text>
            <Text color="cyan">{`  psql -h ${host} -p ${instance.port} -U ${instance.superuser} -d postgres`}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="green">{`✓ Persisted ${allowList.length} allow-list entry(ies). Press [I] on Home to view.`}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="green" bold>{'[Enter] '}</Text><Text color="white">{'done'}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (step === 'failure' && probe) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="red" paddingX={2} flexDirection="column">
          <Text color="red" bold>{`✗  Connection failed (${probe.code})`}</Text>
          <Text color={mutedColor}>{'─'.repeat(56)}</Text>
          <Text color="white">{probe.message}</Text>
          {!!resolved && <Text color={mutedColor}>{`  Resolved ${host} → ${resolved}`}</Text>}
          <Box marginTop={1} flexDirection="column">
            <Text color={mutedColor}>{'Most common causes (in order):'}</Text>
            {probe.code === 'timeout' && (
              <>
                <Text color="white">{'  1. Cloud provider security group (AWS / GCP / DigitalOcean) — open inbound TCP ' + instance.port}</Text>
                <Text color="white">{'  2. Host firewall (ufw / firewalld) — the script handles this; did it run as root?'}</Text>
                <Text color="white">{'  3. listen_addresses still localhost — the script flips it; was postgres reloaded?'}</Text>
              </>
            )}
            {probe.code === 'refused' && (
              <>
                <Text color="white">{'  1. PostgreSQL is not listening on port ' + instance.port + ' on the VPS'}</Text>
                <Text color="white">{'  2. Check on the VPS:  ss -ltnp | grep ' + instance.port}</Text>
                <Text color="white">{'  3. Verify the script reloaded postgres (look for the 4/4 line in its output)'}</Text>
              </>
            )}
            {probe.code === 'unreachable' && (
              <Text color="white">{'  Routing problem — the host is offline or unreachable from this network.'}</Text>
            )}
            {probe.code === 'dns' && (
              <Text color="white">{'  DNS lookup failed for the hostname — check the host value on the instance.'}</Text>
            )}
            {probe.code === 'other' && (
              <Text color="white">{'  See message above for the OS error code.'}</Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color="green" bold>{'[R / Enter] '}</Text><Text color="white">{'retry test   '}</Text>
            <Text color={mutedColor} bold>{'[Esc] '}</Text><Text color={mutedColor}>{'back to review'}</Text>
          </Box>
        </Box>
        <Keybindings bindings={[
          { key: 'R',   label: 'retry'  },
          { key: 'Esc', label: 'back'   },
        ]} />
      </Box>
    );
  }

  return <Text color="red">{'Unknown step.'}</Text>;
};
