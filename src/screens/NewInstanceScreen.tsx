import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import * as os   from 'os';
import * as path from 'path';
import { ActivityLog }      from '../components/ActivityLog';
import { Keybindings }      from '../components/Keybindings';
import { PeekPasswordInput } from '../components/PeekPasswordInput';
import { initDb, startInstance, findFreePort } from '../services/pgctl';
import { configureHostedMode } from '../services/pgConfig';
import { validatePassword, validatePort } from '../services/security';
import { allInstalledVersions } from '../services/pgDetect';
import type { InstalledVersion } from '../services/pgDetect';
import type { Navigation }     from '../hooks/useNavigation';
import type { InstancesState } from '../hooks/useInstances';
import type { Instance, InstallationType, LogEntry } from '../types';
import { mutedColor } from '../theme';

type Step = 'version' | 'placement' | 'name' | 'superuser' | 'port' | 'password' | 'password-confirm' | 'datadir' | 'running' | 'done' | 'error';
type Phase = 'idle' | 'initdb' | 'configuring' | 'starting' | 'verifying' | 'complete';

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
  const [step,            setStep]           = useState<Step>('placement');
  const [placement,       setPlacement]      = useState<InstallationType>('local');
  const [name,            setName]           = useState('');
  const [superuser,       setSuperuser]      = useState('postgres');
  const [superuserError,  setSuperuserError] = useState<string | null>(null);
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

  // All available PostgreSQL installations on this machine. Loaded once at mount.
  const [availableVersions, setAvailableVersions] = useState<InstalledVersion[]>([]);
  const [versionIdx,        setVersionIdx]        = useState(0);
  // The active binaries — start from props, updated when user picks a version.
  const [activeInitdb, setActiveInitdb] = useState(initdbBin);
  const [activePgCtl,  setActivePgCtl]  = useState(pgCtlBin);

  // Guard against calling setState on an unmounted component from async
  // callbacks (allInstalledVersions, execFile). Without this, Ink 3's
  // reconciler can enter a broken render state causing the UI to freeze.
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  useEffect(() => {
    allInstalledVersions().then(versions => {
      if (!mountedRef.current) return;
      setAvailableVersions(versions);
      // If more than one version exists, ask the user to choose before placement.
      // If there is only one (or none), skip straight to placement and use the
      // prop-provided binaries as-is.
      if (versions.length > 1) {
        setStep('version');
        // Pre-select whichever entry matches the prop-provided initdb.
        const idx = versions.findIndex(v => v.initdb === initdbBin);
        setVersionIdx(idx >= 0 ? idx : 0);
        if (versions[0]) {
          setActiveInitdb(versions[0].initdb);
          setActivePgCtl(versions[0].pgCtl);
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect the PostgreSQL version label from the active initdb binary.
  const [pgVersion, setPgVersion] = useState<string>('');
  useEffect(() => {
    if (!activeInitdb) return;
    execFile(activeInitdb, ['--version'], (_err, stdout) => {
      if (!mountedRef.current) return;
      const match = stdout?.match(/(\d+\.\d+)/);
      if (match) setPgVersion(match[1] ?? '');
    });
  }, [activeInitdb]);

  // Slow-tick spinner: 1s interval instead of ink-spinner's ~80ms so we only
  // cause one full Ink re-render per second during the running phase, reducing
  // terminal flicker heavily over SSH connections.
  // Phase list: include the 'configuring' step only for hosted instances on Linux
  // so the progress bar always reflects exactly the work being done.
  const PHASES = React.useMemo(
    () => {
      const base: { id: Phase; label: string }[] = [
        { id: 'initdb',      label: 'Initialising data directory'       },
        { id: 'starting',    label: 'Starting PostgreSQL server'        },
        { id: 'verifying',   label: 'Verifying connection'              },
      ];
      if (placement === 'hosted' && process.platform === 'linux') {
        base.splice(1, 0, { id: 'configuring', label: 'Configuring for network access' });
      }
      return base;
    },
    [placement],
  );

  const [spinTick, setSpinTick] = useState(0);
  useEffect(() => {
    if (step !== 'running') return;
    const t = setInterval(() => setSpinTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [step]);
  const SPIN_CHARS = ['⠙', '⠸', '⠴', '⠦', '⠇', '⠋'];
  const spinChar = SPIN_CHARS[spinTick % SPIN_CHARS.length] ?? '⠙';

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
    setStep('superuser');
  }, [resolveDefaults]);

  /**
   * Validate the bootstrap superuser name. PostgreSQL role names must start
   * with a letter or underscore and may contain letters, digits and
   * underscores. We also forbid pg_* (reserved by PostgreSQL itself).
   */
  const handleSuperuserSubmit = useCallback((value: string) => {
    const v = value.trim();
    if (!v) {
      setSuperuserError('Superuser name is required.');
      return;
    }
    if (v.length > 63) {
      setSuperuserError('Superuser name must be 63 characters or fewer.');
      return;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) {
      setSuperuserError('Use letters, digits and underscores only; must start with a letter or underscore.');
      return;
    }
    if (/^pg_/i.test(v)) {
      setSuperuserError('Names starting with "pg_" are reserved by PostgreSQL.');
      return;
    }
    setSuperuserError(null);
    setSuperuser(v);
    setStep('port');
  }, []);

  const handlePortSubmit = useCallback((value: string) => {
    const check = validatePort(value);
    if (!check.ok) {
      setPortError(check.reason);
      return;
    }
    const p = check.value;

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
    const check = validatePassword(value, placement);
    if (!check.ok) {
      setPasswordError(check.reason);
      return;
    }
    setPassword(value);
    setPasswordConfirm('');
    setPasswordError(null);
    // Skip confirmation for trust auth (empty password, local only)
    if (value.length === 0) {
      setStep('datadir');
    } else {
      setStep('password-confirm');
    }
  }, [placement]);

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
      id:          uuidv4(),
      name:        name,
      port:        portNum,
      dataDir:     dir,
      superuser:   superuser,
      createdAt:   new Date().toISOString(),
      hasPassword: password.length > 0,
      password:    password || undefined,
      installationType:   placement,
      passwordChangedAt:  password.length > 0 ? new Date().toISOString() : undefined,
      pgVersion:          pgVersion || undefined,
    };

    appendLog(makeLog('INFO', `Initialising data directory: ${dir}`));
    appendLog(makeLog('DEBUG', `initdb: ${activeInitdb}`));
    const initRes = await initDb(activeInitdb, dir, superuser, line => {
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

    // Hosted + Linux: configure listen_addresses, pg_hba.conf remote auth rules,
    // and open the firewall port BEFORE starting the server so the first start
    // already picks up the correct configuration.
    if (placement === 'hosted' && process.platform === 'linux') {
      setPhase('configuring');
      appendLog(makeLog('INFO', 'Configuring instance for network access...'));
      const cfgRes = await configureHostedMode(dir, portNum, line => {
        appendLog(makeLog('DEBUG', line));
      });
      if (!cfgRes.ok) {
        appendLog(makeLog('ERROR', `Network configuration failed: ${cfgRes.message}`));
        setError(cfgRes.message);
        setStep('error');
        return;
      }
      appendLog(makeLog('INFO', 'Network configuration applied.'));
    }

    setPhase('starting');
    appendLog(makeLog('INFO', `Starting on port ${portNum}...`));
    appendLog(makeLog('DEBUG', `pg_ctl: ${activePgCtl || '(Windows service)'}`));
    const startRes = await startInstance(activePgCtl, instance, line => {
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
  }, [name, superuser, port, password, dataDir, activePgCtl, activeInitdb, instances, appendLog, placement, pgVersion]);

  /** True when the failure is a Windows DLL loading error. */
  const isDllError = !!(error && (error.includes('0xC0000135') || error.includes('DLL_NOT_FOUND')));

  useInput((input, key) => {
    // Only react to real keypresses.
    const hasKey = !!input || key.return || key.escape ||
                    key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
                    key.tab || key.backspace || key.delete;
    if (!hasKey) return;

    // Never navigate away while instance creation is in progress — the async
    // operation holds references to state and would call setState on an
    // unmounted component, corrupting Ink's render state.
    if (step === 'running') return;

    // Version picker: ↑/↓ to move, Enter to confirm
    if (step === 'version') {
      if (key.upArrow) {
        setVersionIdx(i => {
          const next = Math.max(0, i - 1);
          const v = availableVersions[next];
          if (v) { setActiveInitdb(v.initdb); setActivePgCtl(v.pgCtl); }
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setVersionIdx(i => {
          const next = Math.min(availableVersions.length - 1, i + 1);
          const v = availableVersions[next];
          if (v) { setActiveInitdb(v.initdb); setActivePgCtl(v.pgCtl); }
          return next;
        });
        return;
      }
      if (key.return) {
        setStep('placement');
        return;
      }
      if (key.escape) { nav.pop(); return; }
      return;
    }

    // Placement picker: L = local, H = hosted
    if (step === 'placement') {
      if (input === 'l' || input === 'L') {
        setPlacement('local');
        setStep('name');
        return;
      }
      if (input === 'h' || input === 'H') {
        setPlacement('hosted');
        setStep('name');
        return;
      }
      if (key.escape) { nav.pop(); return; }
      return;
    }

    if (step === 'done' || step === 'error') {
      // On DLL error: [G] navigates directly to the download screen
      if (isDllError && (input === 'g' || input === 'G')) {
        nav.pop();
        nav.push({ name: 'download-pg' });
        return;
      }
      // For HOSTED placement, Enter continues into the GUIDED HOSTED setup
      // wizard, which produces a tailored bash script for the VPS plus a
      // live connection test. Hosted instances are explicitly intended to be
      // reachable from off-host, so we treat this as the natural next step.
      if (step === 'done' && createdInstance && placement === 'hosted' && key.return) {
        nav.pop();
        nav.push({ name: 'hosted-setup', instance: createdInstance });
        return;
      }
      // [X] → set up external / remote access for the freshly-created instance
      // (still available for local instances that the user later wants to expose)
      if (step === 'done' && createdInstance && (input === 'x' || input === 'X')) {
        nav.pop();
        nav.push({ name: 'remote-access', instance: createdInstance });
        return;
      }
      nav.pop();
      return;
    }
    if (key.escape) { nav.pop(); return; }
  });

  return (
    <Box flexDirection="column">
      {/* Version picker — shown only when multiple PostgreSQL versions are installed */}
      {step === 'version' && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text bold color="cyan">{'Select PostgreSQL version'}</Text>
          <Text color={mutedColor}>{'Use ↑ / ↓ to move, Enter to confirm'}</Text>
          <Text color={mutedColor}>{'─'.repeat(60)}</Text>
          <Box flexDirection="column" marginTop={1}>
            {availableVersions.map((v, i) => (
              <Box key={v.initdb}>
                <Text color={i === versionIdx ? 'cyan' : mutedColor} bold={i === versionIdx}>
                  {i === versionIdx ? '▶ ' : '  '}
                </Text>
                <Text color={i === versionIdx ? 'white' : mutedColor} bold={i === versionIdx}>
                  {v.label}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* Placement picker — first step, chooses security posture */}
      {step === 'placement' && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text bold color="cyan">{'Where is this instance running?'}</Text>
          {pgVersion ? (
            <Text color={mutedColor}>{`Using PostgreSQL ${pgVersion}  (${activeInitdb})`}</Text>
          ) : (
            <Text color={mutedColor}>{`initdb: ${activeInitdb || '(not found)'}`}</Text>
          )}
          <Text color={mutedColor}>{'─'.repeat(60)}</Text>
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text color="green" bold>{'[L] '}</Text>
              <Text color="white" bold>{'Local / personal machine'}</Text>
            </Box>
            <Text color={mutedColor}>{'     Bound to 127.0.0.1. Password recommended (min 8 chars).'}</Text>
            <Text color={mutedColor}>{'     Credentials stored encrypted in your user keychain / vault.'}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text color="yellow" bold>{'[H] '}</Text>
              <Text color="white" bold>{'Hosted / shared server'}</Text>
            </Box>
            <Text color={mutedColor}>{'     Network-reachable. Strong password REQUIRED (min 12, 3+ char classes).'}</Text>
            <Text color={mutedColor}>{'     Automatically sets listen_addresses=*, remote pg_hba.conf rules, and'}</Text>
            <Text color={mutedColor}>{'     opens the port in ufw/firewall-cmd. Audit log enabled.'}</Text>
          </Box>
        </Box>
      )}

      {/* Wizard config panel — hidden on 'done' to keep the success view compact
          (terminals shorter than the full output end up scrolling endlessly). */}
      {step !== 'done' && step !== 'placement' && step !== 'version' && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text bold color="cyan">
            {'Step '}
            {step === 'name'      ? '1' :
             step === 'superuser' ? '2' :
             step === 'port'      ? '3' :
             (step === 'password' || step === 'password-confirm') ? '4' : '5'}
            {' of 5'}
            {step === 'password-confirm' ? '  (confirm password)' : ''}
            {'   \u2014   '}
            <Text color={placement === 'hosted' ? 'yellow' : 'green'} bold>
              {placement === 'hosted' ? 'HOSTED mode' : 'LOCAL mode'}
            </Text>
          </Text>

          {/* Step 1 — Name */}
          <Box marginTop={1} flexDirection="row">
            <Text color={step === 'name' ? 'white' : mutedColor} bold={step === 'name'}>
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

          {/* Step 2 — Superuser */}
          {(step === 'superuser' || step === 'port' || step === 'password' || step === 'password-confirm' || step === 'datadir' || step === 'running' || step === 'error') && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={step === 'superuser' ? 'white' : mutedColor} bold={step === 'superuser'}>
                  {'Superuser:      '}
                </Text>
                {step === 'superuser' ? (
                  <TextInput
                    value={superuser}
                    onChange={v => { setSuperuser(v); if (superuserError) setSuperuserError(null); }}
                    onSubmit={handleSuperuserSubmit}
                    placeholder="postgres"
                  />
                ) : (
                  <Text color="green">{superuser}</Text>
                )}
              </Box>
              {step === 'superuser' && !superuserError && (
                <Text color={mutedColor}>
                  {'  Bootstrap role created by initdb. Letters, digits, underscores; must start with a letter or _.'}
                </Text>
              )}
              {!!superuserError && step === 'superuser' && (
                <Text color="red">{'  ✗ '}{superuserError}</Text>
              )}
            </Box>
          )}

          {/* Step 3 — Port */}
          {(step === 'port' || step === 'password' || step === 'password-confirm' || step === 'datadir' || step === 'running' || step === 'error') && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={step === 'port' ? 'white' : mutedColor} bold={step === 'port'}>
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
                <Text color={step === 'password' ? 'white' : mutedColor} bold={step === 'password'}>
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
                  <Text color={password ? 'green' : mutedColor}>
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
              <Text color={step === 'datadir' ? 'white' : mutedColor} bold={step === 'datadir'}>
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
            <Text color="yellow">{spinChar}</Text>
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
              const color = isDone ? 'green' : isCurrent ? 'yellow' : mutedColor;
              return (
                <Box key={p.id}>
                  <Text color={color} bold={isCurrent}>{`  ${icon} `}</Text>
                  <Text color={color}>{p.label}</Text>
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
            <Text color={mutedColor}>{'─'.repeat(56)}</Text>
            <Box flexDirection="row">
              <Text color={mutedColor}>{'Instance:  '}</Text>
              <Text color="cyan" bold>{createdInstance.name}</Text>
              <Text color={mutedColor}>{'   Port: '}</Text>
              <Text color="white">{String(createdInstance.port)}</Text>
              {createdInstance.pgVersion && (
                <>
                  <Text color={mutedColor}>{'   PostgreSQL: '}</Text>
                  <Text color="white">{createdInstance.pgVersion}</Text>
                </>
              )}
            </Box>
            <Box flexDirection="row">
              <Text color={mutedColor}>{'User:      '}</Text>
              <Text color="white">{createdInstance.superuser}</Text>
              <Text color={mutedColor}>{'   Password: '}</Text>
              <Text color={createdInstance.hasPassword ? 'yellow' : mutedColor}>
                {createdInstance.hasPassword ? '(set — use what you entered)' : '(trust auth — none required)'}
              </Text>
            </Box>
            <Box flexDirection="row">
              <Text color={mutedColor}>{'Data dir:  '}</Text>
              <Text color="white">{createdInstance.dataDir}</Text>
            </Box>
            <Text color={mutedColor}>{'─'.repeat(56)}</Text>
            <Text color={mutedColor}>{'Connection URL:'}</Text>
            <Text color="cyan">{
              createdInstance.hasPassword
                ? `  postgresql://${createdInstance.superuser}:<your-password>@127.0.0.1:${createdInstance.port}/postgres`
                : `  postgresql://${createdInstance.superuser}@127.0.0.1:${createdInstance.port}/postgres`
            }</Text>
            <Text color={mutedColor}>{'psql:'}</Text>
            <Text color="cyan">{`  psql -h 127.0.0.1 -p ${createdInstance.port} -U ${createdInstance.superuser} -d postgres`}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {placement === 'hosted' ? (
              <>
                <Box borderStyle="round" borderColor="yellow" paddingX={2} flexDirection="column">
                  <Text color="yellow" bold>{'⚠  Hosted instance — remote access not yet configured'}</Text>
                  <Text color="white">
                    {'PostgreSQL is currently bound to '}
                    <Text color="cyan" bold>{'127.0.0.1'}</Text>
                    {' only. To accept connections from other machines you need to allow specific IPs (Direct TCP) or expose it through an SSH reverse tunnel.'}
                  </Text>
                </Box>
                <Box marginTop={1}>
                  <Text color="green" bold>{'[Enter] '}</Text>
                  <Text color="white">{'Continue to guided hosted setup'}</Text>
                </Box>
                <Box>
                  <Text color={mutedColor} bold>{'[Esc / any key] '}</Text>
                  <Text color={mutedColor}>{'Skip for now — return to Home (you can configure it later from the instance screen)'}</Text>
                </Box>
              </>
            ) : (
              <>
                <Box>
                  <Text color="yellow" bold>{'[X] '}</Text>
                  <Text color="white">{'Set up external access (allow remote IPs or expose via SSH tunnel)'}</Text>
                </Box>
                <Text color={mutedColor}>{'Press any other key to return to Home.'}</Text>
              </>
            )}
          </Box>
        </Box>
      )}

      {step === 'error' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>{'\u2717 Setup failed — check the Activity Log above for details.'}</Text>
          {!!error && (
            <Box borderStyle="round" borderColor="red" paddingX={1} marginTop={1} flexDirection="column">
              {error.split('\n').filter(Boolean).map((line, i) => (
                <Text key={i} color="red">{line}</Text>
              ))}
            </Box>
          )}
          {isDllError ? (
            <Box borderStyle="round" borderColor="yellow" paddingX={2} marginTop={1} flexDirection="column">
              <Text color="yellow" bold>{'\u26a1 Missing DLLs detected'}</Text>
              <Text color="white">{'Press '}<Text color="green" bold>{'[G]'}</Text>{' to download a self-contained portable PostgreSQL right now.'}</Text>
              <Text color={mutedColor}>{'Or press any other key to go back to the Home screen.'}</Text>
            </Box>
          ) : (
            <Text color={mutedColor}>{'Press any key to go back.'}</Text>
          )}
        </Box>
      )}

      {step !== 'done' && (
        <Keybindings bindings={
          step === 'placement' ? [
            { key: 'L', label: 'local' },
            { key: 'H', label: 'hosted' },
            { key: 'Esc', label: 'cancel' },
          ]
          : isDllError && step === 'error' ? [
            { key: 'G',   label: 'download PostgreSQL' },
            { key: 'any', label: 'go back' },
          ] : [
            { key: 'Enter', label: 'next/confirm' },
            { key: 'Esc',   label: 'cancel' },
          ]
        } />
      )}
    </Box>
  );
};
