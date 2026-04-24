import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner   from 'ink-spinner';
import { v4 as uuidv4 } from 'uuid';
import { Client } from 'pg';
import { ActivityLog }       from '../components/ActivityLog';
import { Keybindings }       from '../components/Keybindings';
import { PeekPasswordInput } from '../components/PeekPasswordInput';
import type { Navigation }     from '../hooks/useNavigation';
import type { InstancesState } from '../hooks/useInstances';
import type { Instance, LogEntry } from '../types';

type Step =
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
  const [step,     setStep]     = useState<Step>('name');
  const [name,     setName]     = useState('');
  const [host,     setHost]     = useState('127.0.0.1');
  const [port,     setPort]     = useState('5432');
  const [user,     setUser]     = useState('postgres');
  const [password, setPassword] = useState('');
  const [systemd,  setSystemd]  = useState('');
  const [logs,     setLogs]     = useState<LogEntry[]>([]);
  const [error,    setError]    = useState<string | null>(null);
  const [created,  setCreated]  = useState<Instance | null>(null);

  const isLinux = process.platform === 'linux';

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs(l => [...l, entry]);
  }, []);

  const verifyAndSave = useCallback(async (systemdValue: string) => {
    setStep('verifying');
    setLogs([]);
    const portNum = parseInt(port, 10);
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
      id:          uuidv4(),
      name:        name.trim() || `${hostValue}:${portNum}`,
      host:        hostValue,
      port:        portNum,
      dataDir:     '',
      superuser:   user,
      password:    password || undefined,
      hasPassword: password.length > 0,
      systemdService: systemdValue.trim() || undefined,
      external:    true,
      createdAt:   new Date().toISOString(),
    };
    instances.addInstance(instance);
    appendLog(makeLog('INFO', `Instance "${instance.name}" imported (${isLocal ? 'local' : 'remote'}).`));
    setCreated(instance);
    setStep('done');
  }, [host, port, user, password, name, instances, appendLog]);

  const handleNameSubmit = useCallback((v: string) => {
    setName(v.trim());
    setStep('host');
  }, []);

  const handleHostSubmit = useCallback((v: string) => {
    setHost(v.trim() || '127.0.0.1');
    setStep('port');
  }, []);

  const handlePortSubmit = useCallback((v: string) => {
    const p = parseInt(v.trim(), 10);
    setPort(isNaN(p) ? '5432' : String(p));
    setStep('user');
  }, []);

  const handleUserSubmit = useCallback((v: string) => {
    setUser(v.trim() || 'postgres');
    setStep('password');
  }, []);

  const handlePasswordSubmit = useCallback((v: string) => {
    setPassword(v);
    if (isLinux) {
      setStep('systemd');
    } else {
      void verifyAndSave('');
    }
  }, [isLinux, verifyAndSave]);

  const handleSystemdSubmit = useCallback((v: string) => {
    setSystemd(v);
    void verifyAndSave(v);
  }, [verifyAndSave]);

  const poppedRef = useRef(false);
  useInput((input, key) => {
    const hasKey = !!input || key.return || key.escape ||
                   key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
                   key.tab || key.backspace || key.delete;
    if (!hasKey) return;

    if (step === 'done' || step === 'error') {
      if (poppedRef.current) return;
      poppedRef.current = true;
      nav.pop();
      return;
    }
    if (key.escape) {
      if (poppedRef.current) return;
      poppedRef.current = true;
      nav.pop();
    }
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
      {step !== 'done' && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text bold color="cyan" dimColor>
            {`Import Instance \u2014 Step ${currentStepNum} of ${totalSteps}`}
          </Text>

          {/* Name */}
          <Box marginTop={1} flexDirection="row">
            <Text color={step === 'name' ? 'white' : 'gray'} bold={step === 'name'}>
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
            <Box flexDirection="row">
              <Text color={step === 'host' ? 'white' : 'gray'} bold={step === 'host'}>
                {'Host:               '}
              </Text>
              {step === 'host' ? (
                <TextInput value={host} onChange={setHost} onSubmit={handleHostSubmit} placeholder="127.0.0.1" />
              ) : (
                <Text color="green">{host}</Text>
              )}
            </Box>
          )}

          {/* Port */}
          {(step === 'port' || step === 'user' || step === 'password' || step === 'systemd' || step === 'verifying' || step === 'error') && (
            <Box flexDirection="row">
              <Text color={step === 'port' ? 'white' : 'gray'} bold={step === 'port'}>
                {'Port:               '}
              </Text>
              {step === 'port' ? (
                <TextInput value={port} onChange={setPort} onSubmit={handlePortSubmit} placeholder="5432" />
              ) : (
                <Text color="green">{port}</Text>
              )}
            </Box>
          )}

          {/* User */}
          {(step === 'user' || step === 'password' || step === 'systemd' || step === 'verifying' || step === 'error') && (
            <Box flexDirection="row">
              <Text color={step === 'user' ? 'white' : 'gray'} bold={step === 'user'}>
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
            <Box flexDirection="row">
              <Text color={step === 'password' ? 'white' : 'gray'} bold={step === 'password'}>
                {'Password:           '}
              </Text>
              {step === 'password' ? (
                <PeekPasswordInput value={password} onChange={setPassword} onSubmit={handlePasswordSubmit} placeholder="(leave blank for trust auth)" />
              ) : (
                <Text color={password ? 'green' : 'gray'} dimColor={!password}>
                  {password ? '\u2022'.repeat(Math.min(password.length, 8)) : '(none)'}
                </Text>
              )}
            </Box>
          )}

          {/* systemd (Linux only) */}
          {isLinux && (step === 'systemd' || step === 'verifying' || step === 'error') && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={step === 'systemd' ? 'white' : 'gray'} bold={step === 'systemd'}>
                  {'Systemd unit:       '}
                </Text>
                {step === 'systemd' ? (
                  <TextInput value={systemd} onChange={setSystemd} onSubmit={handleSystemdSubmit} placeholder="(optional, e.g. postgresql@15-main)" />
                ) : (
                  <Text color={systemd ? 'green' : 'gray'} dimColor={!systemd}>
                    {systemd || '(none \u2014 managed externally)'}
                  </Text>
                )}
              </Box>
              {step === 'systemd' && (
                <Text color="gray" dimColor>
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
          <Text color="gray" dimColor>{'Common causes: wrong password, pg_hba.conf rejection, firewall, or server not listening on this host.'}</Text>
        </Box>
      )}

      {step === 'done' && created && (
        <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="green" bold>{`\u2713 Imported "${created.name}"`}</Text>
          <Text color="gray">{`  ${created.host}:${created.port} as ${created.superuser}`}</Text>
          {created.hasPassword && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="yellow" bold>{'\u26a0  Password stored in plaintext'}</Text>
              <Text color="gray">{'  Config file: ~/.pgmanager/config.json'}</Text>
              {process.platform === 'win32' ? (
                <Text color="gray">{'  Windows: ensure %USERPROFILE%\\.pgmanager\\config.json is ACL-restricted to your user.'}</Text>
              ) : (
                <Text color="gray">{'  Run: chmod 600 ~/.pgmanager/config.json'}</Text>
              )}
            </Box>
          )}
          <Text color="gray" dimColor>{'\n  Press any key to return to Home.'}</Text>
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
