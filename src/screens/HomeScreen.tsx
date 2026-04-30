import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as fs from 'fs';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import {
  probeInstanceSecurity,
  type SecurityProbeResult,
  type CheckStatus,
} from '../services/securityProbe';
import { Keybindings }        from '../components/Keybindings';
import { ConfirmDialog }      from '../components/ConfirmDialog';
import { getInstanceStatusColor } from '../theme';
import { getInstanceStatus, startInstance, stopInstance } from '../services/pgctl';
import { useTerminalSize }    from '../hooks/useTerminalSize';
import type { Navigation }    from '../hooks/useNavigation';
import type { InstancesState } from '../hooks/useInstances';
import type { Instance, InstanceStatus } from '../types';

/** Truncate a path so it fits within maxLen, showing '…' prefix when shortened. */
function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  return '\u2026' + path.slice(path.length - (maxLen - 1));
}

const STATUS_ICON: Record<InstanceStatus, string> = {
  running: '●',
  stopped: '○',
  unknown: '◌',
  error:   '✗',
};

/** Visual indicators for security check results. */
const CHECK_ICON: Record<CheckStatus, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
  skip: '—',
  info: 'ℹ',
};
const CHECK_COLOR: Record<CheckStatus, string> = {
  pass: 'green',
  warn: 'yellow',
  fail: 'red',
  skip: 'gray',
  info: 'cyan',
};

interface HomeScreenProps {
  nav:        Navigation;
  instances:  InstancesState;
  pgCtlBin:   string;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({ nav, instances, pgCtlBin }) => {
  const { columns }                        = useTerminalSize();
  const [selected,      setSelected]      = useState(0);
  const [statuses,      setStatuses]      = useState<Record<string, InstanceStatus>>({});
  const [busyId,        setBusyId]        = useState<string | null>(null);
  const [confirmId,     setConfirmId]     = useState<string | null>(null);
  const [confirmDataDir,setConfirmDataDir]= useState<Instance | null>(null);
  const [opLog,         setOpLog]         = useState<string | null>(null);
  const [opError,       setOpError]       = useState<string | null>(null);
  const [showInfo,      setShowInfo]      = useState(false);
  const [showProbe,     setShowProbe]     = useState(false);
  // Security probe: keyed by instance ID. A ref tracks in-flight requests.
  const [probeCache, setProbeCache]      = useState<Record<string, SecurityProbeResult>>({});
  const [probeGen,   setProbeGen]        = useState(0); // increment to force recheck
  const probeRunning                     = useRef<Set<string>>(new Set());

  const list = instances.instances;

  // Poll status for all instances every 3s
  const refreshStatuses = useCallback(async () => {
    const entries = await Promise.all(
      list.map(async i => [i.id, await getInstanceStatus(pgCtlBin, i)] as const),
    );
    const next = Object.fromEntries(entries);
    // Only update React state when something actually changed. Allocating a
    // new object every 3s would trigger a full re-render of the home tree
    // (instance table + activity log + keybindings strip), which is the
    // primary visible flicker source over SSH/VPS sessions.
    setStatuses(prev => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length !== nextKeys.length) return next;
      for (const k of nextKeys) {
        if (prev[k] !== next[k]) return next;
      }
      return prev;
    });
  }, [list, pgCtlBin]);

  useEffect(() => {
    void refreshStatuses();
    const t = setInterval(() => { void refreshStatuses(); }, 3000);
    return () => clearInterval(t);
  }, [refreshStatuses]);

  const selected_instance: Instance | undefined = list[selected];

  // Run the security probe whenever the probe panel is opened for an instance.
  // Results are cached by instance ID so re-opening is instant.
  const selectedId = selected_instance?.id;
  useEffect(() => {
    if (!showProbe || !selected_instance) return;
    const id = selected_instance.id;
    if (probeCache[id] || probeRunning.current.has(id)) return;
    probeRunning.current.add(id);
    const inst = selected_instance; // capture before async gap
    probeInstanceSecurity(inst).then(result => {
      probeRunning.current.delete(id);
      setProbeCache(prev => ({ ...prev, [id]: result }));
    }).catch(() => {
      probeRunning.current.delete(id);
    });
  }, [showProbe, selectedId, probeGen]); // eslint-disable-line react-hooks/exhaustive-deps

  const doToggle = useCallback(async (instance: Instance) => {
    const status = statuses[instance.id];
    setBusyId(instance.id);
    setOpLog(null);
    setOpError(null);
    try {
      if (status === 'running') {
        const res = await stopInstance(pgCtlBin, instance, l => setOpLog(l));
        if (res.ok) { setOpLog('Stopped.'); }
        else        { setOpLog(null); setOpError(res.output || 'pg_ctl stop failed with no output.'); }
      } else {
        const res = await startInstance(pgCtlBin, instance, l => setOpLog(l));
        if (res.ok) { setOpLog('Started.'); }
        else        { setOpLog(null); setOpError(res.output || 'pg_ctl start failed with no output.'); }
      }
    } finally {
      setBusyId(null);
      await refreshStatuses();
    }
  }, [pgCtlBin, statuses, refreshStatuses]);

  const doDelete = useCallback(async (instance: Instance) => {
    setConfirmId(null);
    const status = statuses[instance.id];
    if (status === 'running') {
      setBusyId(instance.id);
      await stopInstance(pgCtlBin, instance);
      setBusyId(null);
    }
    instances.removeInstance(instance.id);
    if (selected >= list.length - 1) setSelected(Math.max(0, list.length - 2));

    // For user-created instances with a data dir on disk, ask if the folder
    // should be wiped too. Skip this for system-managed service instances —
    // removing Program Files data would be destructive and require admin.
    if (!instance.winServiceName && fs.existsSync(instance.dataDir)) {
      setConfirmDataDir(instance);
    }
  }, [pgCtlBin, statuses, instances, list.length, selected]);

  const doDeleteDataDir = useCallback((instance: Instance) => {
    setConfirmDataDir(null);
    try {
      fs.rmSync(instance.dataDir, { recursive: true, force: true });
      setOpLog(`Deleted data directory: ${instance.dataDir}`);
    } catch (err: any) {
      setOpLog(`Failed to delete data directory: ${err.message}`);
    }
  }, []);

  useInput((input, key) => {
    if (confirmId) return; // delegate to ConfirmDialog
    if (confirmDataDir) return; // delegate to data-dir ConfirmDialog
    if (busyId)    return;

    // Close panels with Escape
    if (key.escape && showProbe) { setShowProbe(false); return; }
    if (key.escape && showInfo)  { setShowInfo(false);  return; }

    // Escape also dismisses a visible error log before any other action.
    if (key.escape && opError) { setOpError(null); return; }

    if (key.upArrow)    { setSelected(s => Math.max(0, s - 1)); }
    if (key.downArrow)  { setSelected(s => Math.min(list.length - 1, s + 1)); }

    if (input === 'i' || input === 'I') {
      setShowInfo(s => !s);
    }

    if (input === 'p' || input === 'P') {
      if (showProbe && selected_instance) {
        // Already open — recheck
        const id = selected_instance.id;
        setProbeCache(prev => { const next = { ...prev }; delete next[id]; return next; });
        setProbeGen(g => g + 1);
      } else {
        setShowProbe(s => !s);
      }
    }
    if (input === 'n' || input === 'N') {
      nav.push({ name: 'new-instance' });
    }
    if (input === 'a' || input === 'A') {
      nav.push({ name: 'import-instance' });
    }
    if (input === 'g' || input === 'G') {
      nav.push({ name: 'download-pg' });
    }
    if ((input === '\r' || key.return) && selected_instance) {
      nav.push({ name: 'instance', instance: selected_instance });
    }
    if ((input === 's' || input === 'S') && selected_instance) {
      void doToggle(selected_instance);
    }
    if ((input === 'd' || input === 'D') && selected_instance) {
      setConfirmId(selected_instance.id);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Instance list */}
      <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={1} marginBottom={1}>
        <Box marginBottom={0}>
          <Text bold color="blue">{'NAME              '}</Text>
          <Text bold color="blue">{'PORT   '}</Text>
          <Text bold color="blue">{'STATUS    '}</Text>
          <Text bold color="blue">{'DATA DIR'}</Text>
        </Box>
        <Text color="gray" dimColor>{'─'.repeat(72)}</Text>

        {list.length === 0 && (
          <Text color="gray" dimColor>{'  No instances yet. Press [N] to create, [A] to add a remote, or [G] to download PostgreSQL.'}</Text>
        )}

        {list.map((inst, i) => {
          const status = statuses[inst.id] ?? 'unknown';
          const color  = getInstanceStatusColor(status);
          const icon   = STATUS_ICON[status];
          const isBusy = busyId === inst.id;
          const isSel  = i === selected;
          const host   = inst.host ?? '127.0.0.1';
          const isRemote = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
          const rawLocation = isRemote ? `${host}:${inst.port}` : (inst.dataDir || `localhost:${inst.port}`);
          // NAME(18) + PORT(7) + STATUS(11) + [R](4 opt) + border/padding(4) = ~44 fixed chars
          const locationMax = Math.max(10, columns - 44 - (isRemote ? 4 : 0));
          const location = truncatePath(rawLocation, locationMax);

          return (
            <Box key={inst.id} flexDirection="row">
              <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                {`${isSel ? '▶ ' : '  '}${inst.name.padEnd(16)}`}
              </Text>
              <Text color={isSel ? 'cyan' : 'gray'}>{String(inst.port).padEnd(7)}</Text>
              {isBusy ? (
                <Box>
                  <Text color="yellow"><Spinner type="dots" /></Text>
                  <Text color="yellow">{'  busy     '}</Text>
                </Box>
              ) : (
                <Text color={color}>{`${icon} ${status.padEnd(9)}`}</Text>
              )}
              {isRemote && <Text color="magenta" bold>{'[R] '}</Text>}
              <Text color="gray" dimColor>{location}</Text>
            </Box>
          );
        })}
      </Box>

      {opLog && (
        <Box marginBottom={1}>
          <Text color="gray" dimColor>{`  ${opLog}`}</Text>
        </Box>
      )}

      {opError && (
        <Box
          borderStyle="round"
          borderColor="red"
          flexDirection="column"
          paddingX={1}
          marginBottom={1}
        >
          <Text color="red" bold>{'✗ Operation failed — see log below'}</Text>
          {opError.split('\n').filter(Boolean).slice(-60).map((line, i) => (
            <Text
              key={i}
              color={/error|fatal|could not|denied|refused/i.test(line) ? 'red' : 'gray'}
              dimColor={!/error|fatal|could not|denied|refused/i.test(line)}
            >
              {line}
            </Text>
          ))}
          <Text color="gray" dimColor>{'  (Press Esc to dismiss)'}</Text>
        </Box>
      )}

      {confirmId && selected_instance && (
        <ConfirmDialog
          message={`Delete instance "${selected_instance.name}"? This will remove it from pgmanager.`}
          danger
          onConfirm={() => void doDelete(selected_instance)}
          onCancel={() => setConfirmId(null)}
        />
      )}

      {confirmDataDir && (
        <ConfirmDialog
          message={`Also delete the data directory "${confirmDataDir.dataDir}"? This permanently erases all databases.`}
          danger
          onConfirm={() => doDeleteDataDir(confirmDataDir)}
          onCancel={() => setConfirmDataDir(null)}
        />
      )}

      {/* Instance info panel — toggled by [I] */}
      {showInfo && selected_instance && (() => {
        const inst    = selected_instance;
        const host    = inst.host ?? '127.0.0.1';
        const isRemote = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
        const connUrl = inst.hasPassword
          ? `  postgresql://${inst.superuser}:<your-password>@${host}:${inst.port}/postgres`
          : `  postgresql://${inst.superuser}@${host}:${inst.port}/postgres`;
        const psqlCmd = inst.hasPassword
          ? `  psql -h ${host} -p ${inst.port} -U ${inst.superuser} -W -d postgres`
          : `  psql -h ${host} -p ${inst.port} -U ${inst.superuser} -d postgres`;
        return (
          <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="cyan" bold>{'Instance Info'}</Text>
            <Text color="gray">{'─'.repeat(56)}</Text>
            <Box flexDirection="row">
              <Text color="gray">{'Instance:  '}</Text>
              <Text color="cyan" bold>{inst.name}</Text>
              {isRemote && <Text color="magenta" bold>{'   [REMOTE]'}</Text>}
              {inst.external && !isRemote && <Text color="blue" bold>{'   [EXTERNAL]'}</Text>}
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Host/Port: '}</Text>
              <Text color="white">{`${host}:${inst.port}`}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'User:      '}</Text>
              <Text color="white">{inst.superuser}</Text>
              <Text color="gray">{'   Password: '}</Text>
              <Text color={inst.hasPassword ? 'yellow' : 'gray'} dimColor={!inst.hasPassword}>
                {inst.hasPassword ? '(set \u2014 use the password you created)' : '(trust auth \u2014 none required)'}
              </Text>
            </Box>
            {inst.dataDir && (
              <Box flexDirection="row">
                <Text color="gray">{'Data dir:  '}</Text>
                <Text color="white">{inst.dataDir}</Text>
              </Box>
            )}
            {inst.pgVersion && (
              <Box flexDirection="row">
                <Text color="gray">{'PG version:'}</Text>
                <Text color="white">{`  PostgreSQL ${inst.pgVersion}`}</Text>
              </Box>
            )}
            {inst.systemdService && (
              <Box flexDirection="row">
                <Text color="gray">{'Systemd:   '}</Text>
                <Text color="white">{inst.systemdService}</Text>
              </Box>
            )}
            {inst.winServiceName && (
              <Box flexDirection="row">
                <Text color="gray">{'Service:   '}</Text>
                <Text color="white">{inst.winServiceName}</Text>
              </Box>
            )}
            {(() => {
              const ra = inst.remoteAccess;
              const cidrs = ra?.directCidrs ?? [];
              const tunnels = ra?.sshTunnels ?? [];
              if (cidrs.length === 0 && tunnels.length === 0) return null;
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Text color="gray">{'─'.repeat(56)}</Text>
                  <Text color="magenta" bold>{'Online Access'}</Text>
                  {ra?.listenAllUpdated && (
                    <Box flexDirection="row">
                      <Text color="gray">{'Listen:    '}</Text>
                      <Text color="white">{'all interfaces (0.0.0.0 / ::) — postgresql.conf updated'}</Text>
                    </Box>
                  )}
                  {cidrs.length > 0 && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text color="gray">{`Direct TCP allow-list (${cidrs.length}):`}</Text>
                      {cidrs.map((c, i) => (
                        <Box key={`cidr-${i}`} flexDirection="row">
                          <Text color="cyan">{'  • '}</Text>
                          <Text color="white">{c.cidr}</Text>
                          <Text color="gray" dimColor>{`   (added ${c.addedAt.slice(0, 10)})`}</Text>
                        </Box>
                      ))}
                    </Box>
                  )}
                  {tunnels.length > 0 && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text color="gray">{`SSH reverse tunnels (${tunnels.length}):`}</Text>
                      {tunnels.map((t, i) => (
                        <Box key={`tun-${i}`} flexDirection="column">
                          <Box flexDirection="row">
                            <Text color="cyan">{'  • '}</Text>
                            <Text color="white">{`${t.sshUser}@${t.remoteHost}:${t.sshPort}`}</Text>
                            <Text color="gray">{'  →  remote port '}</Text>
                            <Text color="white">{String(t.remotePort)}</Text>
                          </Box>
                          {t.serviceName && (
                            <Text color="gray" dimColor>{`      service: ${t.serviceName}`}</Text>
                          )}
                        </Box>
                      ))}
                      <Box marginTop={1} flexDirection="column">
                        <Text color="gray" dimColor>{'    Connect from a tunnel client with:'}</Text>
                        {tunnels.map((t, i) => (
                          <Text key={`tun-cmd-${i}`} color="cyan">
                            {`      psql -h 127.0.0.1 -p ${t.remotePort} -U ${inst.superuser} -d postgres`}
                          </Text>
                        ))}
                      </Box>
                    </Box>
                  )}
                  <Text color="gray" dimColor>{'    Press [X] on the instance screen to manage online access.'}</Text>
                </Box>
              );
            })()}
            <Text color="gray">{'─'.repeat(56)}</Text>
            <Text color="gray">{'Connection URL:'}</Text>
            <Text color="cyan">{connUrl}</Text>
            <Text color="gray">{'psql:'}</Text>
            <Text color="cyan">{psqlCmd}</Text>
            {isRemote && !inst.systemdService && (
              <Box marginTop={1} flexDirection="column">
                <Text color="gray" dimColor>{'Remote instance: start/stop is managed externally.'}</Text>
                <Text color="gray" dimColor>{'To control it via pgmanager, set a systemd unit name when importing.'}</Text>
              </Box>
            )}
          </Box>
        );
      })()}

      {/* Security probe panel — toggled by [P] */}
      {showProbe && selected_instance && (() => {
        const inst = selected_instance;
        const probe = probeCache[inst.id];
        return (
          <Box
            borderStyle="round"
            borderColor={inst.installationType === 'hosted' ? 'yellow' : 'green'}
            flexDirection="column"
            paddingX={2}
            marginBottom={1}
          >
            <Text color={inst.installationType === 'hosted' ? 'yellow' : 'green'} bold>
              {inst.installationType === 'hosted' ? '\u26a0  Security Probe \u2014 HOSTED' : '\u2713  Security Probe'}
            </Text>
            <Text color="gray">{'─'.repeat(56)}</Text>

            {/* Vault encryption — always known, no connection needed */}
            <Box flexDirection="row">
              <Text color="green">{'\u2713 '}</Text>
              <Text color="gray" bold>{'Credential storage: '}</Text>
              <Text color="gray">{'AES-256-GCM vault.enc (mode 0600).'}</Text>
            </Box>

            {/* Live probe results */}
            {!probe ? (
              <Box flexDirection="row" marginTop={1}>
                <Text color="yellow"><Spinner type="dots" /></Text>
                <Text color="gray">{'  Running checks\u2026'}</Text>
              </Box>
            ) : (
              <>
                {probe.connectionError && (
                  <Text color="gray" dimColor>
                    {`Live checks skipped (server unreachable): ${probe.connectionError}`}
                  </Text>
                )}
                {probe.checks.map((check, i) => (
                  <Box key={i} flexDirection="row">
                    <Text color={CHECK_COLOR[check.status]}>{`${CHECK_ICON[check.status]} `}</Text>
                    <Text color="gray" bold>{`${check.label}: `}</Text>
                    <Text color="gray">{check.detail}</Text>
                  </Box>
                ))}
                <Text color="gray" dimColor>
                  {`Checked at ${new Date(probe.ranAt).toLocaleTimeString()}  \u2014  [P] to recheck  [Esc] to close`}
                </Text>
              </>
            )}
          </Box>
        );
      })()}

      <Keybindings bindings={[
        { key: '\u2191\u2193', label: 'navigate' },
        { key: 'Enter', label: 'open' },
        { key: 'I', label: 'instance info' },
        { key: 'P', label: showProbe ? 'recheck security' : 'security probe' },
        { key: 'N', label: 'new instance' },
        { key: 'A', label: 'add remote' },
        { key: 'S', label: 'start/stop' },
        { key: 'D', label: 'delete' },
        { key: 'G', label: 'get PostgreSQL' },
        { key: 'Q', label: 'quit' },
      ]} />
    </Box>
  );
};
