import React, { useState, useEffect, useCallback } from 'react';
import * as fs from 'fs';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { Keybindings }         from '../components/Keybindings';
import { ConfirmDialog }       from '../components/ConfirmDialog';
import { getInstanceStatusColor, mutedColor } from '../theme';
import {
  getInstanceStatus,
  startInstance,
  stopInstance,
} from '../services/pgctl';
import { listDatabases }       from '../services/database';
import { useAsync }            from '../hooks/useAsync';
import type { Navigation }     from '../hooks/useNavigation';
import type { InstancesState } from '../hooks/useInstances';
import type { DatabaseInfo, Instance, InstanceStatus } from '../types';

const STATUS_ICON: Record<InstanceStatus, string> = {
  running: '●',
  stopped: '○',
  unknown: '◌',
  error:   '✗',
};

interface InstanceScreenProps {
  nav:        Navigation;
  instances:  InstancesState;
  instance:   Instance;
  pgCtlBin:   string;
}

export const InstanceScreen: React.FC<InstanceScreenProps> = ({
  nav, instances, instance, pgCtlBin,
}) => {
  const [status,    setStatus]    = useState<InstanceStatus>('unknown');
  const [selected,  setSelected]  = useState(0);
  const [busyOp,    setBusyOp]    = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmDataDir, setConfirmDataDir] = useState(false);
  const [opMsg,     setOpMsg]     = useState<string | null>(null);
  const [opError,   setOpError]   = useState<string | null>(null);

  const dbState = useAsync<DatabaseInfo[]>(
    () => (status === 'running' ? listDatabases(instance) : Promise.resolve([])),
    [instance.id, status],
  );
  const dbs = dbState.data ?? [];

  // Refresh status every 3s. Only call setStatus when the value actually
  // changed — otherwise every poll triggers a full re-render of this
  // screen (info panel + databases table) which is a major flicker source
  // over SSH where every redraw is visible.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const s = await getInstanceStatus(pgCtlBin, instance);
      if (cancelled) return;
      setStatus(prev => (prev === s ? prev : s));
    };
    void refresh();
    const t = setInterval(() => { void refresh(); }, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [pgCtlBin, instance]);

  const doToggle = useCallback(async () => {
    setBusyOp(true);
    setOpMsg(null);
    setOpError(null);
    try {
      if (status === 'running') {
        const res = await stopInstance(pgCtlBin, instance, l => setOpMsg(l));
        if (res.ok) {
          setOpMsg('Stopped.');
        } else {
          setOpMsg(null);
          setOpError(res.output || 'pg_ctl stop failed with no output.');
        }
      } else {
        const res = await startInstance(pgCtlBin, instance, l => setOpMsg(l));
        if (res.ok) {
          setOpMsg('Started.');
        } else {
          setOpMsg(null);
          setOpError(res.output || 'pg_ctl start failed with no output.');
        }
      }
    } finally {
      setBusyOp(false);
      const newStatus = await getInstanceStatus(pgCtlBin, instance);
      setStatus(newStatus);
    }
  }, [pgCtlBin, instance, status]);

  const doDelete = useCallback(async () => {
    setConfirmDel(false);
    if (status === 'running') {
      await stopInstance(pgCtlBin, instance);
    }
    instances.removeInstance(instance.id);
    // Ask about the data dir only for user-created instances.
    if (!instance.winServiceName && fs.existsSync(instance.dataDir)) {
      setConfirmDataDir(true);
    } else {
      nav.pop();
    }
  }, [pgCtlBin, instance, status, instances, nav]);

  const doDeleteDataDir = useCallback(() => {
    setConfirmDataDir(false);
    try {
      fs.rmSync(instance.dataDir, { recursive: true, force: true });
    } catch {
      /* swallow — instance already removed from manager */
    }
    nav.pop();
  }, [instance.dataDir, nav]);

  useInput((input, key) => {
    if (confirmDel || confirmDataDir || busyOp) return;
    // Allow Escape to dismiss a visible error panel before popping the screen.
    if (key.escape && opError) { setOpError(null); return; }
    if (key.upArrow)   setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(dbs.length - 1, s + 1));
    if (key.escape)    { nav.pop(); return; }
    if (input === 'n' || input === 'N') {
      nav.push({ name: 'databases', instance, database: undefined });
    }
    if ((key.return || input === '\r') && dbs[selected]) {
      nav.push({ name: 'databases', instance, database: dbs[selected]!.name });
    }
    if (input === 's' || input === 'S') void doToggle();
    if (input === 'd' || input === 'D') setConfirmDel(true);
    if (input === 'u' || input === 'U') nav.push({ name: 'users', instance });
    if (input === 'a' || input === 'A') nav.push({ name: 'provision-app', instance });
    if (input === 'p' || input === 'P') nav.push({ name: 'project-database', instance });
    if (input === 'x' || input === 'X') nav.push({ name: 'remote-access', instance });
    if ((input === 'h' || input === 'H') && instance.installationType === 'hosted') {
      nav.push({ name: 'hosted-setup', instance });
    }
    if (input === 't' || input === 'T') nav.push({ name: 'cloudflare-tunnel', instance });
    if (input === 'm' || input === 'M') {
      if (dbs[selected]) nav.push({ name: 'migrations', instance, database: dbs[selected]!.name });
    }
  });

  const statusColor = getInstanceStatusColor(status);
  const icon        = STATUS_ICON[status];

  return (
    <Box flexDirection="column">
      {/* Info panel */}
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
        <Box flexDirection="row" marginBottom={0}>
          <Text color={mutedColor}>{'Port: '}</Text>
          <Text color="white" bold>{String(instance.port)}</Text>
          <Text color={mutedColor}>{'    Superuser: '}</Text>
          <Text color="white">{instance.superuser}</Text>
          <Text color={mutedColor}>{'    Status: '}</Text>
          {busyOp ? (
            <><Text color="yellow"><Spinner type="dots" /></Text><Text color="yellow">{'  ...'}</Text></>
          ) : (
            <Text color={statusColor} bold>{`${icon} ${status}`}</Text>
          )}
        </Box>
        <Box flexDirection="row">
          <Text color={mutedColor}>{'Data: '}</Text>
          <Text color={mutedColor}>{instance.dataDir}</Text>
        </Box>
        {!!instance.remoteAccess && (
          ((instance.remoteAccess.directCidrs?.length ?? 0) > 0 ||
           (instance.remoteAccess.sshTunnels?.length  ?? 0) > 0) && (
            <Box flexDirection="row">
              <Text color={mutedColor}>{'Remote: '}</Text>
              <Text color={(instance.remoteAccess.directCidrs?.length ?? 0) > 0 ? 'yellow' : mutedColor}>
                {`${instance.remoteAccess.directCidrs?.length ?? 0} direct CIDR(s)`}
              </Text>
              <Text color={mutedColor}>{'   '}</Text>
              <Text color={(instance.remoteAccess.sshTunnels?.length ?? 0) > 0 ? 'yellow' : mutedColor}>
                {`${instance.remoteAccess.sshTunnels?.length ?? 0} SSH tunnel(s)`}
              </Text>
            </Box>
          )
        )}
      </Box>

      {!!opMsg && <Box marginBottom={1}><Text color={mutedColor}>{`  ${opMsg}`}</Text></Box>}

      {!!opError && (
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
              color={/error|fatal|could not|denied|refused/i.test(line) ? 'red' : mutedColor}
            >
              {line}
            </Text>
          ))}
          <Text color={mutedColor}>{'  (Press Esc to dismiss)'}</Text>
        </Box>
      )}

      {/* Databases list */}
      <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={1} marginBottom={1}>
        <Box>
          <Text bold color="blue">{'NAME                OWNER           ENCODING   SIZE'}</Text>
        </Box>
        <Text color={mutedColor}>{'─'.repeat(60)}</Text>
        {status !== 'running' && (
          <Text color={mutedColor}>{'  Instance is not running.'}</Text>
        )}
        {status === 'running' && dbState.loading && (
          <Box><Text color="yellow"><Spinner type="dots" /></Text><Text color={mutedColor}>{'  Loading...'}</Text></Box>
        )}
        {status === 'running' && dbState.error && (
          <Text color="red">{`  Error: ${dbState.error}`}</Text>
        )}
        {status === 'running' && !dbState.loading && dbs.length === 0 && (
          <Text color={mutedColor}>{'  No user databases found.'}</Text>
        )}
        {dbs.map((db, i) => {
          const isSel = i === selected;
          return (
            <Box key={db.name} flexDirection="row">
              <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                {`${isSel ? '▶ ' : '  '}${db.name.padEnd(20)}`}
              </Text>
              <Text color={mutedColor}>{db.owner.padEnd(16)}</Text>
              <Text color={mutedColor}>{db.encoding.padEnd(11)}</Text>
              <Text color={mutedColor}>{db.sizePretty}</Text>
            </Box>
          );
        })}
      </Box>

      {confirmDel && (
        <ConfirmDialog
          message={`Delete instance "${instance.name}" from manager?`}
          danger
          onConfirm={() => void doDelete()}
          onCancel={() => setConfirmDel(false)}
        />
      )}

      {confirmDataDir && (
        <ConfirmDialog
          message={`Also delete the data directory "${instance.dataDir}"? This permanently erases all databases.`}
          danger
          onConfirm={() => doDeleteDataDir()}
          onCancel={() => { setConfirmDataDir(false); nav.pop(); }}
        />
      )}

      <Keybindings bindings={[
        { key: '↑↓',   label: 'navigate'   },
        { key: 'Enter', label: 'open db'    },
        { key: 'N',     label: 'new db'     },
        { key: 'S',     label: 'start/stop' },
        { key: 'U',     label: 'users'      },
        { key: 'A',     label: 'app db'     },
        { key: 'P',     label: 'project db'  },
        { key: 'X',     label: 'external'   },
        ...(instance.installationType === 'hosted'
          ? [{ key: 'H', label: 'hosted setup' }]
          : []),
        { key: 'T',     label: 'cf tunnel'  },
        { key: 'M',     label: 'migrations' },
        { key: 'D',     label: 'delete'     },
        { key: 'Esc',   label: 'back'       },
      ]} />
    </Box>
  );
};
