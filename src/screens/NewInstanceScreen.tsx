import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner   from 'ink-spinner';
import { v4 as uuidv4 } from 'uuid';
import * as os   from 'os';
import * as path from 'path';
import { ActivityLog }      from '../components/ActivityLog';
import { Keybindings }      from '../components/Keybindings';
import { PeekPasswordInput } from '../components/PeekPasswordInput';
import { initDb, startInstance, findFreePort } from '../services/pgctl';
import type { Navigation }     from '../hooks/useNavigation';
import type { InstancesState } from '../hooks/useInstances';
import type { Instance, LogEntry } from '../types';

type Step = 'name' | 'port' | 'password' | 'password-confirm' | 'datadir' | 'running' | 'done' | 'error';
type Phase = 'idle' | 'initdb' | 'starting' | 'verifying' | 'complete';

const PHASES: { id: Phase; label: string }[] = [
  { id: 'initdb',    label: 'Initialising data directory' },
  { id: 'starting',  label: 'Starting PostgreSQL server'  },
  { id: 'verifying', label: 'Verifying connection'        },
];

let _logId = 1;
function makeLog(level: LogEntry['level'], msg: string): LogEntry {
  return {
    id:        _logId++,
    timestamp: new Date().toLocaleTimeString(),
    level,
    service:   'wizard',
    message:   msg,
  };
}

interface NewInstanceScreenProps {
  nav:       Navigation;
  instances: InstancesState;
  pgCtlBin:  string;
  initdbBin: string;
}

export const NewInstanceScreen: React.FC<NewInstanceScreenProps> = ({
  nav, instances, pgCtlBin, initdbBin,
}) => {
  const [step,            setStep]           = useState<Step>('name');
  const [name,            setName]           = useState('');
  const [port,            setPort]           = useState('');
  const [portError,       setPortError]      = useState<string | null>(null);
  const [password,        setPassword]       = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [passwordError,   setPasswordError]  = useState<string | null>(null);
  const [dataDir,         setDataDir]        = useState('');
  const [logs,    setLogs]    = useState<LogEntry[]>([]);
  const [error,   setError]   = useState<string | null>(null);
  const [phase,   setPhase]   = useState<Phase>('idle');
  const [createdInstance, setCreatedInstance] = useState<Instance | null>(null);

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs(l => [...l, entry]);
  }, []);

  const resolveDefaults = useCallback(async (instanceName: string) => {
    // Skip ports already registered with pgmanager, so two instances never
    // claim the same port — even when one of them is currently stopped.
    const reserved = instances.instances.map(i => i.port);
    const freePort = await findFreePort(5432, reserved);
    const defaultDir = path.join(os.homedir(), '.pgmanager', 'data', instanceName);
    return { freePort: String(freePort), defaultDir };
  }, [instances.instances]);

  const handleNameSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim() || 'default';
    setName(trimmed);
    const { freePort, defaultDir } = await resolveDefaults(trimmed);
    setPort(freePort);
    setDataDir(defaultDir);
    setStep('port');
  }, [resolveDefaults]);

  const handlePortSubmit = useCallback((value: string) => {
    const raw = value.trim();
    const p   = parseInt(raw, 10);

    // Reject non-numeric or out-of-range ports. 1024+ avoids privileged
    // ports that require root/admin on most systems.
    if (isNaN(p) || p < 1 || p > 65535) {
      setPortError('Port must be a number between 1 and 65535.');
      return;
    }
    if (p < 1024) {
      setPortError('Ports below 1024 require admin/root privileges. Pick 1024 or higher.');
      return;
    }

    // Reject collisions with any already-registered instance on the same host,
    // regardless of whether that instance is currently running. A stopped
    // instance still owns its port — starting a second instance on it would
    // fail or clash as soon as either one was brought up.
    const host = '127.0.0.1';
    const conflict = instances.instances.find(i => {
      const iHost = i.host ?? '127.0.0.1';
      return i.port === p && iHost === host;
    });
    if (conflict) {
      setPortError(
        `Port ${p} is already assigned to instance "${conflict.name}". ` +
        `Delete that instance first, or choose a different port.`,
      );
      return;
    }

    setPortError(null);
    setPort(String(p));
    setStep('password');
  }, [instances.instances]);

  const handlePasswordSubmit = useCallback((value: string) => {
    setPassword(value);
    setPasswordConfirm('');
    setPasswordError(null);
    // Skip confirmation for trust auth (empty password)
    if (value.length === 0) {
      setStep('datadir');
    } else {
      setStep('password-confirm');
    }
  }, []);

  const handlePasswordConfirmSubmit = useCallback((confirm: string) => {
    if (confirm === password) {
      setPasswordError(null);
      setStep('datadir');
    } else {
      setPasswordError('Passwords do not match — please try again.');
      setPassword('');
      setPasswordConfirm('');
      setStep('password');
    }
  }, [password]);

  const handleDataDirSubmit = useCallback(async (value: string) => {
    const dir = value.trim() || dataDir;
    setDataDir(dir);
    setStep('running');
    setLogs([]);
    setPhase('initdb');

    const portNum = parseInt(port, 10);
    const instance: Instance = {
      id:        uuidv4(),
      name:      name,
      port:      portNum,
      dataDir:   dir,
      superuser: 'postgres',
      createdAt: new Date().toISOString(),
      hasPassword: password.length > 0,
      password:  password || undefined,
    };

    appendLog(makeLog('INFO', `Initialising data directory: ${dir}`));
    appendLog(makeLog('DEBUG', `initdb: ${initdbBin}`));
    const initRes = await initDb(initdbBin, dir, 'postgres', line => {
      appendLog(makeLog('DEBUG', line));
    }, password || undefined);

    if (!initRes.ok) {
      const errDetail = initRes.output.trim() || 'initdb exited with an error (no output — check binary path and permissions)';
      appendLog(makeLog('ERROR', `initdb failed: ${errDetail}`));
      setError(errDetail);
      setStep('error');
      return;
    }
    appendLog(makeLog('INFO', 'Data directory initialised.'));
    setPhase('starting');
    appendLog(makeLog('INFO', `Starting on port ${portNum}...`));
    appendLog(makeLog('DEBUG', `pg_ctl: ${pgCtlBin || '(Windows service)'}`))
    const startRes = await startInstance(pgCtlBin, instance, line => {
      appendLog(makeLog('DEBUG', line));
    });

    if (!startRes.ok) {
      const errDetail = startRes.output.trim() || 'pg_ctl start exited with an error (no output)';
      appendLog(makeLog('ERROR', `Start failed: ${errDetail}`));
      setError(errDetail);
      setStep('error');
      return;
    }

    setPhase('verifying');
    appendLog(makeLog('INFO', `Instance "${name}" started on port ${portNum}.`));
    instances.addInstance(instance);
    setCreatedInstance(instance);
    setPhase('complete');
    setStep('done');
  }, [name, port, password, dataDir, pgCtlBin, initdbBin, instances, appendLog]);

  const poppedRef = useRef(false);

  /** True when the failure is a Windows DLL loading error. */
  const isDllError = !!(error && (error.includes('0xC0000135') || error.includes('DLL_NOT_FOUND')));

  useInput((input, key) => {
    // Only react to real keypresses, and only pop once per terminal screen.
    const hasKey = !!input || key.return || key.escape ||
                    key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
                    key.tab || key.backspace || key.delete;
    if (!hasKey) return;

    if (step === 'done' || step === 'error') {
      if (poppedRef.current) return;
      // On DLL error: [G] navigates directly to the download screen
      if (isDllError && (input === 'g' || input === 'G')) {
        poppedRef.current = true;
        nav.pop();
        nav.push({ name: 'download-pg' });
        return;
      }
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

  return (
    <Box flexDirection="column">
      {/* Wizard config panel — hidden on 'done' to keep the success view compact
          (terminals shorter than the full output end up scrolling endlessly). */}
      {step !== 'done' && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text bold color="cyan" dimColor>
            {'Step '}
            {step === 'name' ? '1' :
             step === 'port' ? '2' :
             (step === 'password' || step === 'password-confirm') ? '3' : '4'}
            {' of 4'}
            {step === 'password-confirm' ? '  (confirm password)' : ''}
          </Text>

          {/* Step 1 — Name */}
          <Box marginTop={1} flexDirection="row">
            <Text color={step === 'name' ? 'white' : 'gray'} bold={step === 'name'}>
              {'Instance name:  '}
            </Text>
            {step === 'name' ? (
              <TextInput
                value={name}
                onChange={setName}
                onSubmit={handleNameSubmit}
                placeholder="default"
              />
            ) : (
              <Text color="green">{name || 'default'}</Text>
            )}
          </Box>

          {/* Step 2 — Port */}
          {(step === 'port' || step === 'password' || step === 'password-confirm' || step === 'datadir' || step === 'running' || step === 'error') && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={step === 'port' ? 'white' : 'gray'} bold={step === 'port'}>
                  {'Port:           '}
                </Text>
                {step === 'port' ? (
                  <TextInput
                    value={port}
                    onChange={v => { setPort(v); if (portError) setPortError(null); }}
                    onSubmit={handlePortSubmit}
                    placeholder="5432"
                  />
                ) : (
                  <Text color="green">{port}</Text>
                )}
              </Box>
              {!!portError && step === 'port' && (
                <Text color="red">{'  ✗ '}{portError}</Text>
              )}
            </Box>
          )}

          {/* Step 3 — Password */}
          {(step === 'password' || step === 'password-confirm' || step === 'datadir' || step === 'running' || step === 'error') && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={step === 'password' ? 'white' : 'gray'} bold={step === 'password'}>
                  {'Password:         '}
                </Text>
                {step === 'password' ? (
                  <PeekPasswordInput
                    value={password}
                    onChange={setPassword}
                    onSubmit={handlePasswordSubmit}
                    placeholder="(leave blank for no password)"
                  />
                ) : (
                  <Text color={password ? 'green' : 'gray'} dimColor={!password}>
                    {password ? '*'.repeat(Math.min(password.length, 12)) : '(no password — trust auth)'}
                  </Text>
                )}
              </Box>
              {!!passwordError && step === 'password' && (
                <Text color="red">{'  ✗ '}{passwordError}</Text>
              )}
              {/* Confirm sub-step — visible only while confirming */}
              {step === 'password-confirm' && (
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    <Text color="white" bold>{'Confirm password: '}</Text>
                    <PeekPasswordInput
                      value={passwordConfirm}
                      onChange={setPasswordConfirm}
                      onSubmit={handlePasswordConfirmSubmit}
                      placeholder="re-enter your password"
                    />
                  </Box>
                </Box>
              )}
            </Box>
          )}

          {/* Step 4 — Data dir */}
          {(step === 'datadir' || step === 'running' || step === 'error') && (
            <Box flexDirection="row">
              <Text color={step === 'datadir' ? 'white' : 'gray'} bold={step === 'datadir'}>
                {'Data directory: '}
              </Text>
              {step === 'datadir' ? (
                <TextInput
                  value={dataDir}
                  onChange={setDataDir}
                  onSubmit={handleDataDirSubmit}
                  placeholder={dataDir}
                />
              ) : (
                <Text color="green">{dataDir}</Text>
              )}
            </Box>
          )}
        </Box>
      )}

      {/* Activity log — only during running / error (hidden on done to save rows) */}
      {(step === 'running' || step === 'error') && (
        <ActivityLog logs={logs} maxLines={6} />
      )}

      {step === 'running' && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
          <Box>
            <Text color="yellow"><Spinner type="dots" /></Text>
            <Text color="yellow" bold>{'  Setting up your instance…'}</Text>
          </Box>
          {/* Progress bar */}
          <Box marginTop={1}>
            {(() => {
              const currentIdx = PHASES.findIndex(p => p.id === phase);
              const completed  = currentIdx < 0 ? 0 : currentIdx;
              const totalSteps = PHASES.length;
              const width      = 40;
              const filled     = Math.round((completed / totalSteps) * width);
              return (
                <>
                  <Text color="white">{`[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`}</Text>
                  <Text color="cyan">{`  ${Math.round((completed / totalSteps) * 100)}%`}</Text>
                </>
              );
            })()}
          </Box>
          {/* Step list */}
          <Box flexDirection="column" marginTop={1}>
            {PHASES.map((p) => {
              const currentIdx = PHASES.findIndex(pp => pp.id === phase);
              const myIdx      = PHASES.findIndex(pp => pp.id === p.id);
              const isDone     = myIdx < currentIdx;
              const isCurrent  = myIdx === currentIdx;
              const icon  = isDone ? '✓' : isCurrent ? '•' : '○';
              const color = isDone ? 'green' : isCurrent ? 'yellow' : 'gray';
              return (
                <Box key={p.id}>
                  <Text color={color} bold={isCurrent}>{`  ${icon} `}</Text>
                  <Text color={color} dimColor={!isCurrent && !isDone}>{p.label}</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {step === 'done' && createdInstance && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2}>
            <Text color="green" bold>{'✓ Instance created and running'}</Text>
            <Text color="gray">{'─'.repeat(56)}</Text>
            <Box flexDirection="row">
              <Text color="gray">{'Instance:  '}</Text>
              <Text color="cyan" bold>{createdInstance.name}</Text>
              <Text color="gray">{'   Port: '}</Text>
              <Text color="white">{String(createdInstance.port)}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'User:      '}</Text>
              <Text color="white">{createdInstance.superuser}</Text>
              <Text color="gray">{'   Password: '}</Text>
              <Text color={createdInstance.hasPassword ? 'yellow' : 'gray'} dimColor={!createdInstance.hasPassword}>
                {createdInstance.hasPassword ? '(set — use what you entered)' : '(trust auth — none required)'}
              </Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Data dir:  '}</Text>
              <Text color="white">{createdInstance.dataDir}</Text>
            </Box>
            <Text color="gray">{'─'.repeat(56)}</Text>
            <Text color="gray">{'Connection URL:'}</Text>
            <Text color="cyan">{
              createdInstance.hasPassword
                ? `  postgresql://${createdInstance.superuser}:${password}@127.0.0.1:${createdInstance.port}/postgres`
                : `  postgresql://${createdInstance.superuser}@127.0.0.1:${createdInstance.port}/postgres`
            }</Text>
            <Text color="gray">{'psql:'}</Text>
            <Text color="cyan">{`  psql -h 127.0.0.1 -p ${createdInstance.port} -U ${createdInstance.superuser} -d postgres`}</Text>
          </Box>
          <Text color="gray" dimColor>{'Press any key to return to Home.'}</Text>
        </Box>
      )}

      {step === 'error' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>{'\u2717 Setup failed — check the Activity Log above for details.'}</Text>
          {!!error && (
            <Box borderStyle="round" borderColor="red" paddingX={1} marginTop={1} flexDirection="column">
              {error.split('\n').filter(Boolean).map((line, i) => (
                <Text key={i} color="red" dimColor>{line}</Text>
              ))}
            </Box>
          )}
          {isDllError ? (
            <Box borderStyle="round" borderColor="yellow" paddingX={2} marginTop={1} flexDirection="column">
              <Text color="yellow" bold>{'\u26a1 Missing DLLs detected'}</Text>
              <Text color="white">{'Press '}<Text color="green" bold>{'[G]'}</Text>{' to download a self-contained portable PostgreSQL right now.'}</Text>
              <Text color="gray" dimColor>{'Or press any other key to go back to the Home screen.'}</Text>
            </Box>
          ) : (
            <Text color="gray" dimColor>{'Press any key to go back.'}</Text>
          )}
        </Box>
      )}

      {step !== 'done' && (
        <Keybindings bindings={isDllError && step === 'error' ? [
          { key: 'G',   label: 'download PostgreSQL' },
          { key: 'any', label: 'go back' },
        ] : [
          { key: 'Enter', label: 'next/confirm' },
          { key: 'Esc',   label: 'cancel' },
        ]} />
      )}
    </Box>
  );
};
