import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner   from 'ink-spinner';
import { v4 as uuidv4 } from 'uuid';
import { Client } from 'pg';
import { ActivityLog }       from '../components/ActivityLog';
import { Keybindings }       from '../components/Keybindings';
import { PeekPasswordInput } from '../components/PeekPasswordInput';
import { validatePassword, validatePort, validateHost } from '../services/security';
import type { Navigation }     from '../hooks/useNavigation';
import type { InstancesState } from '../hooks/useInstances';
import type { Instance, InstallationType, LogEntry } from '../types';
import { mutedColor } from '../theme';

type Step =
  | 'placement'
  | 'name'
  | 'host'
  | 'port'
  | 'user'
  | 'password'
  | 'systemd'
  | 'verifying'
  | 'done'
  | 'error';

let _logId = 1;
function makeLog(level: LogEntry['level'], msg: string): LogEntry {
  return {
    id:        _logId++,
    timestamp: new Date().toLocaleTimeString(),
    level,
    service:   'import',
    message:   msg,
  };
}

interface ImportInstanceScreenProps {
  nav:       Navigation;
  instances: InstancesState;
}

export const ImportInstanceScreen: React.FC<ImportInstanceScreenProps> = ({ nav, instances }) => {
  const [step,          setStep]          = useState<Step>('placement');
  const [placement,     setPlacement]     = useState<InstallationType>('local');
  const [name,          setName]          = useState('');
  const [host,          setHost]          = useState('127.0.0.1');
  const [hostError,     setHostError]     = useState<string | null>(null);
  const [port,          setPort]          = useState('5432');
  const [portError,     setPortError]     = useState<string | null>(null);
  const [user,          setUser]          = useState('postgres');
  const [password,      setPassword]      = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [systemd,       setSystemd]       = useState('');
  const [logs,          setLogs]          = useState<LogEntry[]>([]);
  const [error,         setError]         = useState<string | null>(null);
  const [created,       setCreated]       = useState<Instance | null>(null);

  const isLinux = process.platform === 'linux';

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs(l => [...l, entry]);
  }, []);

  const verifyAndSave = useCallback(async (systemdValue: string) => {
    setStep('verifying');
    setLogs([]);
    const portNum   = parseInt(port, 10);
    const hostValue = host.trim() || '127.0.0.1';

    appendLog(makeLog('INFO', `Connecting to ${hostValue}:${portNum} as ${user}...`));

    const client = new Client({
      host:     hostValue,
      port:     portNum,
      user,
      password: password || undefined,
      database: 'postgres',
      connectionTimeoutMillis: 8000,
    });

    try {
      await client.connect();
      appendLog(makeLog('INFO', 'TCP connection established.'));
      const res = await client.query<{ version: string }>('SELECT version() AS version');
      const version = res.rows[0]?.version ?? 'unknown';
      appendLog(makeLog('INFO', `Server reports: ${version.substring(0, 80)}`));
      await client.end();
    } catch (err: any) {
      try { await client.end(); } catch { /* ignore */ }
      const msg = err?.message ?? String(err);
      appendLog(makeLog('ERROR', `Verification failed: ${msg}`));
      setError(msg);
      setStep('error');
      return;
    }

    const isLocal = hostValue === '127.0.0.1' || hostValue === 'localhost' || hostValue === '::1';
    const instance: Instance = {
      id:               uuidv4(),
      name:             name.trim() || `${hostValue}:${portNum}`,
      host:             hostValue,
      port:             portNum,
      dataDir:          '',
      superuser:        user,
      password:           password || undefined,
      hasPassword:        password.length > 0,
      systemdService:     systemdValue.trim() || undefined,
      external:           true,
      createdAt:          new Date().toISOString(),
      installationType:   placement,
      passwordChangedAt:  password.length > 0 ? new Date().toISOString() : undefined,
    };
    instances.addInstance(instance);
    appendLog(makeLog('INFO', `Instance "${instance.name}" imported (${isLocal ? 'local' : 'remote'}, ${placement}).`));
    setCreated(instance);
    setStep('done');
  }, [host, port, user, password, name, instances, appendLog, placement]);

  const handleNameSubmit = useCallback((v: string) => {
    setName(v.trim());
    setStep('host');
  }, []);

  const handleHostSubmit = useCallback((v: string) => {
    const check = validateHost(v);
    if (!check.ok) {
      setHostError(check.reason);
      return;
    }
    setHostError(null);
    setHost(check.value);
    setStep('port');
  }, []);

  const handlePortSubmit = useCallback((v: string) => {
    const check = validatePort(v);
    if (!check.ok) {
      setPortError(check.reason);
      return;
    }
    setPortError(null);
    setPort(String(check.value));
    setStep('user');
  }, []);

  const handleUserSubmit = useCallback((v: string) => {
    setUser(v.trim() || 'postgres');
    setStep('password');
  }, []);

  const handlePasswordSubmit = useCallback((v: string) => {
    const check = validatePassword(v, placement);
    if (!check.ok) {
      setPasswordError(check.reason);
      return;
    }
    setPasswordError(null);
    setPassword(v);
    if (isLinux) {
      setStep('systemd');
    } else {
      void verifyAndSave('');
    }
  }, [isLinux, verifyAndSave, placement]);

  const handleSystemdSubmit = useCallback((v: string) => {
    setSystemd(v);
    void verifyAndSave(v);
  }, [verifyAndSave]);

  useInput((input, key) => {
    const hasKey = !!input || key.return || key.escape ||
                   key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
                   key.tab || key.backspace || key.delete;
    if (!hasKey) return;

    // Block navigation while verification is running — the async operation
    // holds state references and navigating away would call setState on an
    // unmounted component.
    if (step === 'verifying') return;

    if (step === 'placement') {
      if (input === 'l' || input === 'L') { setPlacement('local');  setStep('name'); return; }
      if (input === 'h' || input === 'H') { setPlacement('hosted'); setStep('name'); return; }
      if (key.escape) { nav.pop(); return; }
      return;
    }

    if (step === 'done' || step === 'error') {
      nav.pop();
      return;
    }
    if (key.escape) { nav.pop(); return; }
  });

  const totalSteps = isLinux ? 6 : 5;
  const currentStepNum =
    step === 'name'     ? 1 :
    step === 'host'     ? 2 :
    step === 'port'     ? 3 :
    step === 'user'     ? 4 :
    step === 'password' ? 5 :
    step === 'systemd'  ? 6 :
    totalSteps;

  return (
    <Box flexDirection="column">
      {step === 'placement' && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text bold color="cyan">{'Where is the instance you are importing?'}</Text>
          <Text color={mutedColor}>{'─'.repeat(60)}</Text>
          <Box flexDirection="column" marginTop={1}>
            <Box><Text color="green" bold>{'[L] '}</Text><Text color="white" bold>{'Local / personal machine'}</Text></Box>
            <Text color={mutedColor}>{'     Loopback connection. Password recommended, stored in your vault.'}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Box><Text color="yellow" bold>{'[H] '}</Text><Text color="white" bold>{'Hosted / shared server'}</Text></Box>
            <Text color={mutedColor}>{'     Network-reachable. Strong password REQUIRED. Prefer SSH tunnels.'}</Text>
          </Box>
          <Keybindings bindings={[
            { key: 'L',   label: 'local' },
            { key: 'H',   label: 'hosted' },
            { key: 'Esc', label: 'cancel' },
          ]} />
        </Box>
      )}

      {step !== 'done' && step !== 'placement' && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text bold color="cyan">
            {`Import Instance \u2014 Step ${currentStepNum} of ${totalSteps}   \u2014   `}
            <Text color={placement === 'hosted' ? 'yellow' : 'green'} bold>
              {placement === 'hosted' ? 'HOSTED mode' : 'LOCAL mode'}
            </Text>
          </Text>

          {/* Name */}
          <Box marginTop={1} flexDirection="row">
            <Text color={step === 'name' ? 'white' : mutedColor} bold={step === 'name'}>
              {'Display name:       '}
            </Text>
            {step === 'name' ? (
              <TextInput value={name} onChange={setName} onSubmit={handleNameSubmit} placeholder="(optional)" />
            ) : (
              <Text color="green">{name || '(auto)'}</Text>
            )}
          </Box>

          {/* Host */}
          {(step !== 'name') && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={step === 'host' ? 'white' : mutedColor} bold={step === 'host'}>
                  {'Host:               '}
                </Text>
                {step === 'host' ? (
                  <TextInput value={host} onChange={v => { setHost(v); if (hostError) setHostError(null); }} onSubmit={handleHostSubmit} placeholder="127.0.0.1" />
                ) : (
                  <Text color="green">{host}</Text>
                )}
              </Box>
              {!!hostError && step === 'host' && (
                <Text color="red">{'  ✗ '}{hostError}</Text>
              )}
            </Box>
          )}

          {/* Port */}
          {(step === 'port' || step === 'user' || step === 'password' || step === 'systemd' || step === 'verifying' || step === 'error') && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={step === 'port' ? 'white' : mutedColor} bold={step === 'port'}>
                  {'Port:               '}
                </Text>
                {step === 'port' ? (
                  <TextInput value={port} onChange={v => { setPort(v); if (portError) setPortError(null); }} onSubmit={handlePortSubmit} placeholder="5432" />
                ) : (
                  <Text color="green">{port}</Text>
                )}
              </Box>
              {!!portError && step === 'port' && (
                <Text color="red">{'  ✗ '}{portError}</Text>
              )}
            </Box>
          )}

          {/* User */}
          {(step === 'user' || step === 'password' || step === 'systemd' || step === 'verifying' || step === 'error') && (
            <Box flexDirection="row">
              <Text color={step === 'user' ? 'white' : mutedColor} bold={step === 'user'}>
                {'Superuser / role:   '}
              </Text>
              {step === 'user' ? (
                <TextInput value={user} onChange={setUser} onSubmit={handleUserSubmit} placeholder="postgres" />
              ) : (
                <Text color="green">{user}</Text>
              )}
            </Box>
          )}

          {/* Password */}
          {(step === 'password' || step === 'systemd' || step === 'verifying' || step === 'error') && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={step === 'password' ? 'white' : mutedColor} bold={step === 'password'}>
                  {'Password:           '}
                </Text>
                {step === 'password' ? (
                  <PeekPasswordInput value={password} onChange={v => { setPassword(v); if (passwordError) setPasswordError(null); }} onSubmit={handlePasswordSubmit} placeholder={placement === 'hosted' ? '(required, 12+ chars)' : '(leave blank for trust auth)'} />
                ) : (
                  <Text color={password ? 'green' : mutedColor}>
                    {password ? '\u2022'.repeat(Math.min(password.length, 8)) : '(none)'}
                  </Text>
                )}
              </Box>
              {!!passwordError && step === 'password' && (
                <Text color="red">{'  ✗ '}{passwordError}</Text>
              )}
            </Box>
          )}

          {/* systemd (Linux only) */}
          {isLinux && (step === 'systemd' || step === 'verifying' || step === 'error') && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={step === 'systemd' ? 'white' : mutedColor} bold={step === 'systemd'}>
                  {'Systemd unit:       '}
                </Text>
                {step === 'systemd' ? (
                  <TextInput value={systemd} onChange={setSystemd} onSubmit={handleSystemdSubmit} placeholder="(optional, e.g. postgresql@15-main)" />
                ) : (
                  <Text color={systemd ? 'green' : mutedColor}>
                    {systemd || '(none \u2014 managed externally)'}
                  </Text>
                )}
              </Box>
              {step === 'systemd' && (
                <Text color={mutedColor}>
                  {'  Leave blank if this app should not start/stop the server.'}
                </Text>
              )}
            </Box>
          )}
        </Box>
      )}

      {step === 'verifying' && (
        <Box marginBottom={1}>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text color="yellow">{'  Verifying connection...'}</Text>
        </Box>
      )}

      {step === 'error' && error && (
        <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="red" bold>{'Connection failed'}</Text>
          <Text color="white">{error}</Text>
          <Text color={mutedColor}>{'Common causes: wrong password, pg_hba.conf rejection, firewall, or server not listening on this host.'}</Text>
        </Box>
      )}

      {step === 'done' && created && (
        <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="green" bold>{`\u2713 Imported "${created.name}"`}</Text>
          <Text color={mutedColor}>{`  ${created.host}:${created.port} as ${created.superuser}`}</Text>
          {created.hasPassword && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="green" bold>{'\u2713  Password stored securely in credential vault'}</Text>
              <Text color={mutedColor}>{'  Encrypted at ~/.pgmanager/vault.enc (mode 0600, AES-256-GCM).'}</Text>
              {placement === 'hosted' && (
                <Text color="yellow">{'  \u26a0  Hosted mode \u2014 ensure firewall/pg_hba.conf restrict access, and prefer SSH tunnels for admin.'}</Text>
              )}
            </Box>
          )}
          <Text color={mutedColor}>{'\n  Press any key to return to Home.'}</Text>
        </Box>
      )}

      {logs.length > 0 && <ActivityLog logs={logs} />}

      <Keybindings bindings={[
        { key: 'Enter', label: 'next' },
        { key: 'Esc',   label: 'cancel' },
      ]} />
    </Box>
  );
};
