import React, { useState, useEffect, useCallback } from 'react';
import * as fs from 'fs';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { Keybindings }        from '../components/Keybindings';
import { ConfirmDialog }      from '../components/ConfirmDialog';
import { getInstanceStatusColor } from '../theme';
import { getInstanceStatus, startInstance, stopInstance } from '../services/pgctl';
import type { Navigation }    from '../hooks/useNavigation';
import type { InstancesState } from '../hooks/useInstances';
import type { Instance, InstanceStatus } from '../types';

const STATUS_ICON: Record<InstanceStatus, string> = {
  running: '●',
  stopped: '○',
  unknown: '◌',
  error:   '✗',
};

interface HomeScreenProps {
  nav:        Navigation;
  instances:  InstancesState;
  pgCtlBin:   string;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({ nav, instances, pgCtlBin }) => {
  const [selected,      setSelected]      = useState(0);
  const [statuses,      setStatuses]      = useState<Record<string, InstanceStatus>>({});
  const [busyId,        setBusyId]        = useState<string | null>(null);
  const [confirmId,     setConfirmId]     = useState<string | null>(null);
  const [confirmDataDir,setConfirmDataDir]= useState<Instance | null>(null);
  const [opLog,         setOpLog]         = useState<string | null>(null);

  const list = instances.instances;

  // Poll status for all instances every 3s
  const refreshStatuses = useCallback(async () => {
    const entries = await Promise.all(
      list.map(async i => [i.id, await getInstanceStatus(pgCtlBin, i)] as const),
    );
    setStatuses(Object.fromEntries(entries));
  }, [list, pgCtlBin]);

  useEffect(() => {
    void refreshStatuses();
    const t = setInterval(() => { void refreshStatuses(); }, 3000);
    return () => clearInterval(t);
  }, [refreshStatuses]);

  const selected_instance: Instance | undefined = list[selected];

  const doToggle = useCallback(async (instance: Instance) => {
    const status = statuses[instance.id];
    setBusyId(instance.id);
    setOpLog(null);
    try {
      if (status === 'running') {
        const res = await stopInstance(pgCtlBin, instance, l => setOpLog(l));
        setOpLog(res.ok ? 'Stopped.' : `Error: ${res.output}`);
      } else {
        const res = await startInstance(pgCtlBin, instance, l => setOpLog(l));
        setOpLog(res.ok ? 'Started.' : `Error: ${res.output}`);
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

    if (key.upArrow)    setSelected(s => Math.max(0, s - 1));
    if (key.downArrow)  setSelected(s => Math.min(list.length - 1, s + 1));

    if (input === 'n' || input === 'N') {
      nav.push({ name: 'new-instance' });
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
          <Text color="gray" dimColor>{'  No instances yet. Press [N] to create one.'}</Text>
        )}

        {list.map((inst, i) => {
          const status = statuses[inst.id] ?? 'unknown';
          const color  = getInstanceStatusColor(status);
          const icon   = STATUS_ICON[status];
          const isBusy = busyId === inst.id;
          const isSel  = i === selected;

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
              <Text color="gray" dimColor>{inst.dataDir}</Text>
            </Box>
          );
        })}
      </Box>

      {opLog && (
        <Box marginBottom={1}>
          <Text color="gray" dimColor>{`  ${opLog}`}</Text>
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

      <Keybindings bindings={[
        { key: '↑↓', label: 'navigate' },
        { key: 'Enter', label: 'open' },
        { key: 'N', label: 'new instance' },
        { key: 'S', label: 'start/stop' },
        { key: 'D', label: 'delete' },
        { key: 'G', label: 'get PostgreSQL' },
        { key: 'Q', label: 'quit' },
      ]} />
    </Box>
  );
};
