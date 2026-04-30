import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import {
  validateAllowEntry, validateSshHost, validateSshUser, validateTcpPort,
  applyDirectAccess, revokeDirectAccess,
  generateAndSaveSshTunnel, deleteSshTunnelFile,
  withDirectApplied, withDirectRevoked, withTunnelAdded, withAllTunnelsRevoked,
  type GeneratedTunnel,
} from '../services/remoteAccess';
import { ActivityLog }      from '../components/ActivityLog';
import { Keybindings }      from '../components/Keybindings';
import { ConfirmDialog }    from '../components/ConfirmDialog';
import type { Navigation }  from '../hooks/useNavigation';
import type { InstancesState } from '../hooks/useInstances';
import type { Instance, LogEntry, RemoteAccessConfig, SshTunnelEntry } from '../types';

let _logId = 1;
function makeLog(level: LogEntry['level'], msg: string): LogEntry {
  return {
    id:        _logId++,
    timestamp: new Date().toLocaleTimeString(),
    level,
    service:   'remote-access',
    message:   msg,
  };
}

type Step =
  | 'manage'           // top-level dashboard / menu
  | 'method'           // pick direct vs tunnel
  // Direct TCP flow
  | 'direct-cidr'
  | 'direct-more'
  | 'direct-confirm'
  | 'direct-running'
  | 'direct-done'
  // SSH tunnel flow
  | 'tunnel-host'
  | 'tunnel-user'
  | 'tunnel-ssh-port'
  | 'tunnel-remote-port'
  | 'tunnel-running'
  | 'tunnel-done'
  // Revoke flows
  | 'revoke-direct-confirm'
  | 'revoke-direct-running'
  | 'revoke-tunnels-confirm'
  | 'revoke-tunnels-running'
  // Terminal states
  | 'error';

interface RemoteAccessScreenProps {
  nav:       Navigation;
  instances: InstancesState;
  instance:  Instance;
  pgCtlBin:  string;
}

/**
 * External / remote access configuration screen.
 *
 * Two access methods:
 *   - Direct TCP   — pg_hba.conf + listen_addresses + host firewall (auto)
 *   - SSH Reverse  — generates a service file (systemd / launchd / Task Scheduler)
 *
 * Doubles as a management dashboard: when `instance.remoteAccess` is non-empty
 * we open on the 'manage' step which lets users add / revoke / inspect rules.
 */
export const RemoteAccessScreen: React.FC<RemoteAccessScreenProps> = ({
  nav, instances, instance: initialInstance, pgCtlBin,
}) => {
  // Track the live instance so updates from this screen are immediately
  // reflected (e.g. after applying a direct rule we re-render the manage view).
  const [instance, setInstance] = useState<Instance>(initialInstance);

  const hasAny = !!instance.remoteAccess && (
    (instance.remoteAccess.directCidrs?.length ?? 0) > 0 ||
    (instance.remoteAccess.sshTunnels?.length ?? 0)  > 0
  );

  const [step, setStep] = useState<Step>(hasAny ? 'manage' : 'method');

  // Direct TCP wizard state.
  const [cidrInput, setCidrInput] = useState('');
  const [pendingCidrs, setPendingCidrs] = useState<string[]>([]);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // SSH tunnel wizard state.
  const [tunnelHost, setTunnelHost] = useState('');
  const [tunnelUser, setTunnelUser] = useState('');
  const [tunnelSshPort, setTunnelSshPort]       = useState('22');
  const [tunnelRemotePort, setTunnelRemotePort] = useState(String(instance.port));
  const [generated, setGenerated] = useState<GeneratedTunnel | null>(null);

  // Async / output state.
  const [logs,  setLogs]  = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [opMessage, setOpMessage] = useState<string | null>(null);
  const [restartedInfo, setRestartedInfo] = useState<{ restarted: boolean; restartRequired: boolean } | null>(null);

  const poppedRef = useRef(false);

  const append = useCallback((entry: LogEntry) => setLogs(l => [...l, entry]), []);

  // Persist a remoteAccess config update both in local component state and
  // in the global instances list (which writes config.json).
  const persistConfig = useCallback((nextConfig: RemoteAccessConfig) => {
    const next: Instance = { ...instance, remoteAccess: nextConfig };
    setInstance(next);
    instances.updateInstance(next);
  }, [instance, instances]);

  // Slow-tick spinner for running phases.
  const [spinTick, setSpinTick] = useState(0);
  useEffect(() => {
    if (step !== 'direct-running' && step !== 'tunnel-running' &&
        step !== 'revoke-direct-running' && step !== 'revoke-tunnels-running') return;
    const t = setInterval(() => setSpinTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [step]);
  const SPIN = ['⠙', '⠸', '⠴', '⠦', '⠇', '⠋'];
  const spinChar = SPIN[spinTick % SPIN.length] ?? '⠙';

  // ─── Action handlers ────────────────────────────────────────────────────────

  const doApplyDirect = useCallback(async () => {
    setStep('direct-running');
    setLogs([]);
    setError(null);
    const res = await applyDirectAccess(
      instance,
      { cidrs: pendingCidrs, pgCtlBin, autoRestart: true },
      line => append(makeLog('DEBUG', line)),
    );
    if (!res.ok) {
      append(makeLog('ERROR', res.message));
      setError(res.message);
      setStep('error');
      return;
    }
    append(makeLog('INFO', res.message));
    if (res.firewallWarning) append(makeLog('WARN', res.firewallWarning));
    if (res.firewallSkipped.length > 0) {
      append(makeLog('WARN', `Firewall skipped: ${res.firewallSkipped.join(', ')}`));
    }

    // Detect whether listen_addresses actually had to be flipped — the service
    // tells us via restartRequired (only true when running + listen flipped).
    const listenFlipped = res.restarted || res.restartRequired || (instance.remoteAccess?.listenAllUpdated ?? true);
    persistConfig(withDirectApplied(instance.remoteAccess, res.effectiveCidrs, listenFlipped));
    setRestartedInfo({ restarted: res.restarted, restartRequired: res.restartRequired });
    setStep('direct-done');
  }, [instance, pendingCidrs, pgCtlBin, append, persistConfig]);

  const doRevokeDirect = useCallback(async () => {
    setStep('revoke-direct-running');
    setLogs([]);
    const res = await revokeDirectAccess(instance, pgCtlBin, line => append(makeLog('DEBUG', line)));
    if (!res.ok) {
      append(makeLog('ERROR', res.message));
      setError(res.message);
      setStep('error');
      return;
    }
    append(makeLog('INFO', res.message));
    persistConfig(withDirectRevoked(instance.remoteAccess));
    setOpMessage(res.message);
    setStep('manage');
  }, [instance, pgCtlBin, append, persistConfig]);

  const doGenerateTunnel = useCallback(() => {
    setStep('tunnel-running');
    setLogs([]);
    setError(null);
    try {
      const opts = {
        remoteHost: tunnelHost,
        sshUser:    tunnelUser,
        sshPort:    parseInt(tunnelSshPort, 10),
        remotePort: parseInt(tunnelRemotePort, 10),
      };
      const g = generateAndSaveSshTunnel(instance, opts);
      setGenerated(g);
      append(makeLog('INFO', `Service file written: ${g.filePath}`));

      const entry: SshTunnelEntry = {
        sshUser:         opts.sshUser,
        remoteHost:      opts.remoteHost,
        sshPort:         opts.sshPort,
        remotePort:      opts.remotePort,
        serviceFilePath: g.filePath,
        serviceName:     g.serviceName,
        configuredAt:    new Date().toISOString(),
      };
      persistConfig(withTunnelAdded(instance.remoteAccess, entry));
      setStep('tunnel-done');
    } catch (err: any) {
      append(makeLog('ERROR', String(err?.message ?? err)));
      setError(String(err?.message ?? err));
      setStep('error');
    }
  }, [instance, tunnelHost, tunnelUser, tunnelSshPort, tunnelRemotePort, append, persistConfig]);

  const doRevokeTunnels = useCallback(() => {
    setStep('revoke-tunnels-running');
    const tunnels = instance.remoteAccess?.sshTunnels ?? [];
    for (const t of tunnels) {
      if (t.serviceFilePath) {
        deleteSshTunnelFile(t.serviceFilePath);
        append(makeLog('INFO', `Removed: ${t.serviceFilePath}`));
      }
    }
    persistConfig(withAllTunnelsRevoked(instance.remoteAccess));
    setOpMessage(`Removed ${tunnels.length} tunnel definition(s).`);
    setStep('manage');
  }, [instance, append, persistConfig]);

  // ─── Submit handlers ───────────────────────────────────────────────────────

  const handleCidrSubmit = useCallback((v: string) => {
    const c = validateAllowEntry(v);
    if (!c.ok || !c.value) { setFieldError(c.reason ?? 'Invalid entry'); return; }
    setFieldError(null);
    setPendingCidrs(prev => [...prev, c.value!.value]);
    setCidrInput('');
    setStep('direct-more');
  }, []);

  const handleHostSubmit = useCallback((v: string) => {
    const c = validateSshHost(v);
    if (!c.ok || !c.value) { setFieldError(c.reason ?? 'Invalid host'); return; }
    setFieldError(null);
    setTunnelHost(c.value);
    setStep('tunnel-user');
  }, []);

  const handleUserSubmit = useCallback((v: string) => {
    const c = validateSshUser(v);
    if (!c.ok || !c.value) { setFieldError(c.reason ?? 'Invalid user'); return; }
    setFieldError(null);
    setTunnelUser(c.value);
    setStep('tunnel-ssh-port');
  }, []);

  const handleSshPortSubmit = useCallback((v: string) => {
    const c = validateTcpPort(v);
    if (!c.ok || c.value === undefined) { setFieldError(c.reason ?? 'Invalid port'); return; }
    setFieldError(null);
    setTunnelSshPort(String(c.value));
    setStep('tunnel-remote-port');
  }, []);

  const handleRemotePortSubmit = useCallback((v: string) => {
    const c = validateTcpPort(v);
    if (!c.ok || c.value === undefined) { setFieldError(c.reason ?? 'Invalid port'); return; }
    setFieldError(null);
    setTunnelRemotePort(String(c.value));
    doGenerateTunnel();
  }, [doGenerateTunnel]);

  // ─── Keyboard router ───────────────────────────────────────────────────────

  useInput((input, key) => {
    if (step === 'manage') {
      if (input === 'a' || input === 'A') { setStep('method'); return; }
      if (input === 'r' || input === 'R') {
        if ((instance.remoteAccess?.directCidrs?.length ?? 0) === 0) return;
        setStep('revoke-direct-confirm'); return;
      }
      if (input === 't' || input === 'T') {
        if ((instance.remoteAccess?.sshTunnels?.length ?? 0) === 0) return;
        setStep('revoke-tunnels-confirm'); return;
      }
      if (key.escape) {
        if (poppedRef.current) return;
        poppedRef.current = true;
        nav.pop();
      }
      return;
    }
    if (step === 'method') {
      if (input === 'd' || input === 'D') {
        setPendingCidrs([]);
        setStep('direct-cidr');
        return;
      }
      if (input === 't' || input === 'T') { setStep('tunnel-host'); return; }
      if (key.escape) {
        if (hasAny) { setStep('manage'); return; }
        if (poppedRef.current) return;
        poppedRef.current = true;
        nav.pop();
      }
      return;
    }
    if (step === 'direct-more') {
      if (input === 'y' || input === 'Y') { setStep('direct-cidr'); return; }
      if (input === 'n' || input === 'N' || key.return) {
        if (pendingCidrs.length === 0) { setStep('direct-cidr'); return; }
        setStep('direct-confirm');
        return;
      }
      if (key.escape) { setStep('method'); return; }
      return;
    }
    if (step === 'direct-confirm') {
      if (input === 'y' || input === 'Y' || key.return) { void doApplyDirect(); return; }
      if (input === 'n' || input === 'N' || key.escape)  {
        setPendingCidrs([]);
        setStep('direct-cidr');
        return;
      }
      return;
    }
    if (step === 'direct-done' || step === 'tunnel-done') {
      if (key.escape || key.return) { setStep('manage'); return; }
      return;
    }
    if (step === 'error') {
      if (key.escape || key.return) {
        setError(null);
        setStep(hasAny ? 'manage' : 'method');
        return;
      }
      return;
    }
    if (step === 'revoke-direct-confirm') {
      if (input === 'y' || input === 'Y') { void doRevokeDirect(); return; }
      if (input === 'n' || input === 'N' || key.escape) { setStep('manage'); return; }
      return;
    }
    if (step === 'revoke-tunnels-confirm') {
      if (input === 'y' || input === 'Y') { doRevokeTunnels(); return; }
      if (input === 'n' || input === 'N' || key.escape) { setStep('manage'); return; }
      return;
    }
    // Text-input owning steps: just allow Esc → cancel.
    if (key.escape && (step === 'direct-cidr' || step === 'tunnel-host' ||
        step === 'tunnel-user' || step === 'tunnel-ssh-port' || step === 'tunnel-remote-port')) {
      setFieldError(null);
      setStep(hasAny ? 'manage' : 'method');
    }
  });

  // ─── Render ────────────────────────────────────────────────────────────────

  const host = instance.host ?? '127.0.0.1';
  const directCount = instance.remoteAccess?.directCidrs.length ?? 0;
  const tunnelCount = instance.remoteAccess?.sshTunnels.length  ?? 0;

  return (
    <Box flexDirection="column">
      {/* Context header */}
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
        <Text bold color="cyan">{'External access — '}{instance.name}</Text>
        <Text color="gray" dimColor>
          {'Expose this PostgreSQL instance to remote machines via direct TCP or SSH reverse tunnel.'}
        </Text>
        <Box marginTop={1}>
          <Text color="gray">{'Host: '}</Text><Text color="white">{host}</Text>
          <Text color="gray">{'   Port: '}</Text><Text color="white">{String(instance.port)}</Text>
          <Text color="gray">{'   Allowed sources: '}</Text>
          <Text color={directCount > 0 ? 'yellow' : 'gray'}>{String(directCount)}</Text>
          <Text color="gray">{'   SSH tunnels: '}</Text>
          <Text color={tunnelCount > 0 ? 'yellow' : 'gray'}>{String(tunnelCount)}</Text>
        </Box>
      </Box>

      {/* MANAGE — dashboard */}
      {step === 'manage' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text bold color="green">{'Direct TCP access'}</Text>
            {directCount === 0 ? (
              <Text color="gray" dimColor>{'  None configured.'}</Text>
            ) : (
              <Box flexDirection="column" marginTop={1}>
                {(instance.remoteAccess!.directCidrs).map(c => (
                  <Box key={c.cidr}>
                    <Text color="white">{`  • ${c.cidr.padEnd(20)}`}</Text>
                    <Text color="gray" dimColor>{`  added ${c.addedAt}`}</Text>
                  </Box>
                ))}
                <Box marginTop={1}>
                  <Text color="gray" dimColor>
                    {`  Connect from those IPs:  postgresql://<user>:<pw>@<this-server>:${instance.port}/<db>`}
                  </Text>
                </Box>
              </Box>
            )}
          </Box>

          <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text bold color="blue">{'SSH reverse tunnels'}</Text>
            {tunnelCount === 0 ? (
              <Text color="gray" dimColor>{'  None configured.'}</Text>
            ) : (
              <Box flexDirection="column" marginTop={1}>
                {(instance.remoteAccess!.sshTunnels).map((t, i) => (
                  <Box key={i} flexDirection="column">
                    <Box>
                      <Text color="white">{`  • ${t.sshUser}@${t.remoteHost}:${t.sshPort}`}</Text>
                      <Text color="gray">{'   →   remote 127.0.0.1:'}</Text>
                      <Text color="cyan">{String(t.remotePort)}</Text>
                    </Box>
                    {t.serviceFilePath && (
                      <Text color="gray" dimColor>{`     ${t.serviceFilePath}`}</Text>
                    )}
                  </Box>
                ))}
              </Box>
            )}
          </Box>

          {!!opMessage && (
            <Box marginBottom={1}><Text color="gray" dimColor>{`  ${opMessage}`}</Text></Box>
          )}

          <Keybindings bindings={[
            { key: 'A',   label: 'add access' },
            ...(directCount > 0 ? [{ key: 'R', label: 'revoke direct' }] : []),
            ...(tunnelCount > 0 ? [{ key: 'T', label: 'revoke tunnels' }] : []),
            { key: 'Esc', label: 'back' },
          ]} />
        </Box>
      )}

      {/* METHOD — pick direct vs tunnel */}
      {step === 'method' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text bold color="cyan">{'Choose an access method'}</Text>
            <Box marginTop={1} flexDirection="column">
              <Box>
                <Text color="green" bold>{'[D] '}</Text>
                <Text color="white" bold>{'Direct TCP access'}</Text>
              </Box>
              <Text color="gray" dimColor>{'     Allow specific IPs / CIDRs to reach PostgreSQL on this host.'}</Text>
              <Text color="gray" dimColor>{'     Sets listen_addresses=*, writes pg_hba.conf rules, opens host firewall.'}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Box>
                <Text color="yellow" bold>{'[T] '}</Text>
                <Text color="white" bold>{'SSH reverse tunnel'}</Text>
              </Box>
              <Text color="gray" dimColor>{'     PostgreSQL stays on 127.0.0.1. Generates a service file (systemd/'}</Text>
              <Text color="gray" dimColor>{'     launchd/Task Scheduler) that opens an outbound SSH connection and'}</Text>
              <Text color="gray" dimColor>{'     binds a port on the remote machine. More secure — no firewall hole.'}</Text>
            </Box>
          </Box>
          <Keybindings bindings={[
            { key: 'D',   label: 'direct TCP' },
            { key: 'T',   label: 'SSH tunnel' },
            { key: 'Esc', label: 'back' },
          ]} />
        </Box>
      )}

      {/* DIRECT-CIDR — input */}
      {step === 'direct-cidr' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="white" bold>{'Who is allowed to connect?'}</Text>
            <Text color="gray">{'Enter an '}<Text color="cyan">{'IP address'}</Text>{', a '}<Text color="cyan">{'CIDR block'}</Text>{', or a '}<Text color="cyan">{'domain name'}</Text>{'.'}</Text>
            <Box marginTop={1} flexDirection="column">
              <Box flexDirection="row">
                <Text color="gray" dimColor>{'  Single IP   →  '}</Text>
                <Text color="yellow">{'203.0.113.5'}</Text>
                <Text color="gray" dimColor>{'                 (one specific machine)'}</Text>
              </Box>
              <Box flexDirection="row">
                <Text color="gray" dimColor>{'  CIDR        →  '}</Text>
                <Text color="yellow">{'198.51.100.0/24'}</Text>
                <Text color="gray" dimColor>{'             (a whole subnet)'}</Text>
              </Box>
              <Box flexDirection="row">
                <Text color="gray" dimColor>{'  Domain      →  '}</Text>
                <Text color="yellow">{'home.example.com'}</Text>
                <Text color="gray" dimColor>{'           (resolved by DNS — great for dynamic IPs)'}</Text>
              </Box>
              <Box flexDirection="row">
                <Text color="gray" dimColor>{'  IPv6        →  '}</Text>
                <Text color="yellow">{'2001:db8::/32'}</Text>
              </Box>
            </Box>
            <Box marginTop={1}>
              <Text color="gray" dimColor>
                {'  Tip: domains like DuckDNS / No-IP keep working when your home IP changes.'}
              </Text>
            </Box>
            {pendingCidrs.length > 0 && (
              <Box marginTop={1} flexDirection="column">
                <Text color="gray" dimColor>{'  Already pending:'}</Text>
                {pendingCidrs.map(c => <Text key={c} color="cyan">{`    • ${c}`}</Text>)}
              </Box>
            )}
            <Box marginTop={1}>
              <Text color="white">{'  > '}</Text>
              <TextInput
                value={cidrInput}
                onChange={(v) => { setCidrInput(v); if (fieldError) setFieldError(null); }}
                onSubmit={handleCidrSubmit}
                placeholder="203.0.113.5  or  home.example.com"
              />
            </Box>
            {!!fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
          </Box>
          <Keybindings bindings={[
            { key: 'Enter', label: 'add' },
            { key: 'Esc',   label: 'cancel' },
          ]} />
        </Box>
      )}

      {/* DIRECT-MORE — add another? */}
      {step === 'direct-more' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="green" bold>{`✓ Added ${pendingCidrs[pendingCidrs.length - 1]}`}</Text>
            <Box marginTop={1} flexDirection="column">
              <Text color="gray" dimColor>{'  Pending list:'}</Text>
              {pendingCidrs.map(c => <Text key={c} color="cyan">{`    • ${c}`}</Text>)}
            </Box>
            <Box marginTop={1}>
              <Text color="white">{'Add another? '}</Text>
              <Text color="green" bold>{'[Y] '}</Text>
              <Text color="gray">{'yes  '}</Text>
              <Text color="red" bold>{'[N] '}</Text>
              <Text color="gray">{'no, continue'}</Text>
            </Box>
          </Box>
          <Keybindings bindings={[
            { key: 'Y',   label: 'add another' },
            { key: 'N',   label: 'continue' },
            { key: 'Esc', label: 'cancel' },
          ]} />
        </Box>
      )}

      {/* DIRECT-CONFIRM */}
      {step === 'direct-confirm' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="yellow" bold>{'⚠  Confirm direct TCP access'}</Text>
            <Text color="gray" dimColor>{'  About to apply:'}</Text>
            <Box marginTop={1} flexDirection="column">
              <Text color="gray">{`  • Update postgresql.conf: listen_addresses = '*'`}</Text>
              <Text color="gray">{`  • Append ${pendingCidrs.length} rule(s) to pg_hba.conf (scram-sha-256)`}</Text>
              <Text color="gray">{`  • Open ${process.platform === 'win32' ? 'Windows Firewall' : process.platform === 'linux' ? 'ufw / firewall-cmd' : 'pf (manual)'} for port ${instance.port}/tcp from those CIDRs`}</Text>
              <Text color="gray">{`  • Reload PostgreSQL (or restart if listen_addresses changed)`}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color="gray" dimColor>{'  CIDRs:'}</Text>
              {pendingCidrs.map(c => <Text key={c} color="cyan">{`    • ${c}`}</Text>)}
            </Box>
            <Box marginTop={1}>
              <Text color="green" bold>{'[Y] '}</Text><Text color="gray">{'apply  '}</Text>
              <Text color="red"   bold>{'[N] '}</Text><Text color="gray">{'go back'}</Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* RUNNING — direct */}
      {(step === 'direct-running' || step === 'revoke-direct-running' ||
        step === 'revoke-tunnels-running' || step === 'tunnel-running') && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="yellow" paddingX={2} marginBottom={1}>
            <Text color="yellow">{spinChar}</Text>
            <Text color="yellow" bold>
              {'  '}
              {step === 'direct-running'        ? 'Configuring direct access…' :
               step === 'revoke-direct-running' ? 'Revoking direct access…' :
               step === 'revoke-tunnels-running' ? 'Removing tunnel definitions…' :
                                                   'Generating tunnel service file…'}
            </Text>
          </Box>
          <ActivityLog logs={logs} maxLines={8} />
        </Box>
      )}

      {/* DIRECT-DONE */}
      {step === 'direct-done' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="green" bold>{'✓ Direct TCP access configured'}</Text>
            <Box marginTop={1} flexDirection="column">
              {(instance.remoteAccess?.directCidrs ?? []).map(c => (
                <Text key={c.cidr} color="cyan">{`  • ${c.cidr}`}</Text>
              ))}
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color="gray">{'  Connection (from allowed IPs):'}</Text>
              <Text color="cyan">
                {`    psql -h <this-server> -p ${instance.port} -U <user> -d <db>`}
              </Text>
            </Box>
            {restartedInfo?.restarted && (
              <Box marginTop={1}>
                <Text color="gray" dimColor>{'  PostgreSQL was restarted to apply listen_addresses change.'}</Text>
              </Box>
            )}
            {restartedInfo?.restartRequired && !restartedInfo?.restarted && (
              <Box marginTop={1}>
                <Text color="yellow">{'  ⚠  Restart required to apply listen_addresses change.'}</Text>
              </Box>
            )}
          </Box>
          <Keybindings bindings={[{ key: 'Enter/Esc', label: 'continue' }]} />
        </Box>
      )}

      {/* TUNNEL flow steps */}
      {step === 'tunnel-host' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="white" bold>{'Remote machine SSH host'}</Text>
            <Text color="gray" dimColor>{'  Hostname or IP of the VPS that should be able to reach PostgreSQL.'}</Text>
            <Box marginTop={1}>
              <Text color="white">{'  > '}</Text>
              <TextInput
                value={tunnelHost}
                onChange={(v) => { setTunnelHost(v); if (fieldError) setFieldError(null); }}
                onSubmit={handleHostSubmit}
                placeholder="vps.example.com"
              />
            </Box>
            {!!fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
          </Box>
        </Box>
      )}
      {step === 'tunnel-user' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="white" bold>{'SSH user on the remote machine'}</Text>
            <Text color="gray" dimColor>{'  Must already accept key-based SSH login from this machine.'}</Text>
            <Box marginTop={1}>
              <Text color="white">{'  > '}</Text>
              <TextInput
                value={tunnelUser}
                onChange={(v) => { setTunnelUser(v); if (fieldError) setFieldError(null); }}
                onSubmit={handleUserSubmit}
                placeholder="ubuntu"
              />
            </Box>
            {!!fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
          </Box>
        </Box>
      )}
      {step === 'tunnel-ssh-port' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="white" bold>{'SSH port on the remote machine'}</Text>
            <Box marginTop={1}>
              <Text color="white">{'  > '}</Text>
              <TextInput
                value={tunnelSshPort}
                onChange={(v) => { setTunnelSshPort(v); if (fieldError) setFieldError(null); }}
                onSubmit={handleSshPortSubmit}
                placeholder="22"
              />
            </Box>
            {!!fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
          </Box>
        </Box>
      )}
      {step === 'tunnel-remote-port' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="white" bold>{'Port to expose on the remote machine'}</Text>
            <Text color="gray" dimColor>{'  This port (bound to 127.0.0.1 on the remote) will forward back to'}</Text>
            <Text color="gray" dimColor>{`  127.0.0.1:${instance.port} on this machine.`}</Text>
            <Box marginTop={1}>
              <Text color="white">{'  > '}</Text>
              <TextInput
                value={tunnelRemotePort}
                onChange={(v) => { setTunnelRemotePort(v); if (fieldError) setFieldError(null); }}
                onSubmit={handleRemotePortSubmit}
                placeholder={String(instance.port)}
              />
            </Box>
            {!!fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
          </Box>
        </Box>
      )}

      {/* TUNNEL-DONE */}
      {step === 'tunnel-done' && generated && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="green" bold>{'✓ Tunnel service file generated'}</Text>
            <Text color="gray">{'─'.repeat(56)}</Text>
            <Box flexDirection="row">
              <Text color="gray">{'File:    '}</Text>
              <Text color="white">{generated.filePath}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Service: '}</Text>
              <Text color="white">{generated.serviceName}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color="white" bold>{'Install instructions:'}</Text>
              {generated.installInstructions.map((line, i) => (
                <Text key={i} color="gray">{`  ${line}`}</Text>
              ))}
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color="gray">{'Once running, the remote machine can connect via:'}</Text>
              <Text color="cyan">{`  ${generated.remoteConnectionUrl}`}</Text>
            </Box>
          </Box>
          <Keybindings bindings={[{ key: 'Enter/Esc', label: 'continue' }]} />
        </Box>
      )}

      {/* REVOKE confirms */}
      {step === 'revoke-direct-confirm' && (
        <ConfirmDialog
          danger
          message={`Remove all ${directCount} direct TCP rule(s) from pg_hba.conf and the host firewall?`}
          onConfirm={() => void doRevokeDirect()}
          onCancel={() => setStep('manage')}
        />
      )}
      {step === 'revoke-tunnels-confirm' && (
        <ConfirmDialog
          danger
          message={`Delete all ${tunnelCount} tunnel service file(s) and forget them?`}
          onConfirm={() => doRevokeTunnels()}
          onCancel={() => setStep('manage')}
        />
      )}

      {/* ERROR */}
      {step === 'error' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="red" bold>{'✗ Operation failed'}</Text>
            {!!error && error.split('\n').filter(Boolean).slice(-20).map((line, i) => (
              <Text key={i} color="red" dimColor>{line}</Text>
            ))}
          </Box>
          <ActivityLog logs={logs} maxLines={8} />
          <Keybindings bindings={[{ key: 'Enter/Esc', label: 'go back' }]} />
        </Box>
      )}
    </Box>
  );
};
