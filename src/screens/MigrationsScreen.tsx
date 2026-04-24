import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner   from 'ink-spinner';
import * as path from 'path';
import { ActivityLog }   from '../components/ActivityLog';
import { Keybindings }   from '../components/Keybindings';
import {
  getAppliedMigrations,
  discoverMigrationFiles,
  runMigration,
} from '../services/migrations';
import { useAsync }      from '../hooks/useAsync';
import { getInstances, updateMigrationsDir } from '../services/config';
import type { Navigation }  from '../hooks/useNavigation';
import type { MigrationRecord, LogEntry, Instance } from '../types';

type Mode = 'list' | 'set-dir' | 'running' | 'done' | 'error';

let _logId = 1;
function mkLog(level: LogEntry['level'], msg: string): LogEntry {
  return { id: _logId++, timestamp: new Date().toLocaleTimeString(), level, service: 'migration', message: msg };
}

interface MigrationsScreenProps {
  nav:      Navigation;
  instance: Instance;
  database: string;
}

export const MigrationsScreen: React.FC<MigrationsScreenProps> = ({
  nav, instance, database,
}) => {
  const [mode,       setMode]       = useState<Mode>('list');
  const [migrDir,    setMigrDir]    = useState(
    () => getInstances().find(i => i.id === instance.id)?.lastMigrationsDir ?? '',
  );
  const [newDir,     setNewDir]     = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [logs,       setLogs]       = useState<LogEntry[]>([]);
  const [pendingSel, setPendingSel] = useState(0);

  const appliedState = useAsync<MigrationRecord[]>(
    () => getAppliedMigrations(instance, database),
    [instance.id, database, reloadTick],
  );
  const applied = appliedState.data ?? [];

  const pendingState = useAsync<string[]>(
    () => {
      if (!migrDir) return Promise.resolve([]);
      const appliedSet = new Set(applied.map(m => m.filename));
      return Promise.resolve(
        discoverMigrationFiles(migrDir).filter(f => !appliedSet.has(path.basename(f)))
      );
    },
    [migrDir, reloadTick, applied.length],
  );
  const pending = pendingState.data ?? [];

  const appendLog = useCallback((e: LogEntry) => setLogs(l => [...l, e]), []);

  const doSetDir = useCallback((value: string) => {
    const dir = value.trim();
    if (dir) {
      setMigrDir(dir);
      updateMigrationsDir(instance.id, dir);
    }
    setMode('list');
  }, [instance.id]);

  const doRunMigration = useCallback(async (filename: string) => {
    setMode('running');
    setLogs([]);
    appendLog(mkLog('INFO', `Running: ${filename}`));
    try {
      await runMigration(instance, database, filename);
      appendLog(mkLog('INFO', `Done: ${filename}`));
      setReloadTick(t => t + 1);
      setMode('done');
    } catch (e: unknown) {
      appendLog(mkLog('ERROR', e instanceof Error ? e.message : String(e)));
      setMode('error');
    }
  }, [instance, database, appendLog]);

  const doRunAll = useCallback(async () => {
    if (pending.length === 0) return;
    setMode('running');
    setLogs([]);
    try {
      for (const file of pending) {
        appendLog(mkLog('INFO', `Running: ${file}`));
        await runMigration(instance, database, file);
        appendLog(mkLog('INFO', `Done: ${file}`));
      }
      appendLog(mkLog('INFO', 'All migrations complete.'));
      setReloadTick(t => t + 1);
      setMode('done');
    } catch (e: unknown) {
      appendLog(mkLog('ERROR', e instanceof Error ? e.message : String(e)));
      setMode('error');
    }
  }, [instance, database, pending, appendLog]);

  useInput((input, key) => {
    if (mode === 'set-dir' || mode === 'running') return;
    if (mode === 'done' || mode === 'error') { setMode('list'); return; }
    if (key.upArrow)   setPendingSel(s => Math.max(0, s - 1));
    if (key.downArrow) setPendingSel(s => Math.min(pending.length - 1, s + 1));
    if (key.escape)    nav.pop();
    if (input === 'p' || input === 'P') { setNewDir(migrDir); setMode('set-dir'); }
    if ((key.return || input === '\r') && pending[pendingSel]) {
      void doRunMigration(pending[pendingSel]!);
    }
    if (input === 'a' || input === 'A') void doRunAll();
  });

  return (
    <Box flexDirection="column">
      {/* Migrations directory */}
      <Box marginBottom={1}>
        <Text color="gray" dimColor>{'Migrations dir: '}</Text>
        {migrDir ? (
          <Text color="white">{migrDir}</Text>
        ) : (
          <Text color="yellow">{'(not set — press [P] to configure)'}</Text>
        )}
      </Box>

      {mode === 'set-dir' && (
        <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'Migrations directory: '}</Text>
          <TextInput
            value={newDir}
            onChange={setNewDir}
            onSubmit={doSetDir}
            placeholder="/path/to/migrations"
          />
        </Box>
      )}

      {/* Applied migrations */}
      <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={1} marginBottom={1}>
        <Text bold color="green">{'APPLIED'}</Text>
        <Text color="gray" dimColor>{'─'.repeat(50)}</Text>
        {appliedState.loading && <Box><Text color="yellow"><Spinner type="dots" /></Text></Box>}
        {!appliedState.loading && applied.length === 0 && (
          <Text color="gray" dimColor>{'  None yet.'}</Text>
        )}
        {applied.slice(-8).map(m => (
          <Box key={m.filename} flexDirection="row">
            <Text color="green">{'  ✓ '}</Text>
            <Text color="gray">{m.filename.padEnd(36)}</Text>
            <Text color="gray" dimColor>{m.appliedAt}</Text>
          </Box>
        ))}
      </Box>

      {/* Pending migrations */}
      <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} marginBottom={1}>
        <Text bold color="yellow">{'PENDING'}</Text>
        <Text color="gray" dimColor>{'─'.repeat(50)}</Text>
        {pendingState.loading && <Box><Text color="yellow"><Spinner type="dots" /></Text></Box>}
        {!pendingState.loading && pending.length === 0 && migrDir && (
          <Text color="gray" dimColor>{'  All up to date.'}</Text>
        )}
        {!pendingState.loading && pending.length === 0 && !migrDir && (
          <Text color="gray" dimColor>{'  Set migrations directory first.'}</Text>
        )}
        {pending.map((f, i) => {
          const isSel = i === pendingSel;
          return (
            <Box key={f}>
              <Text color={isSel ? 'cyan' : 'yellow'} bold={isSel}>
                {`${isSel ? '▶ ' : '  '}${path.basename(f)}`}
              </Text>
            </Box>
          );
        })}
      </Box>

      {(mode === 'running' || mode === 'done' || mode === 'error') && (
        <ActivityLog logs={logs} maxLines={6} />
      )}

      {mode === 'running' && (
        <Box><Text color="yellow"><Spinner type="dots" /></Text><Text color="yellow">{'  Running migration...'}</Text></Box>
      )}
      {mode === 'done' && (
        <Box><Text color="green" bold>{'✓ Migration complete. Press any key.'}</Text></Box>
      )}
      {mode === 'error' && (
        <Box><Text color="red" bold>{'✗ Migration failed. Press any key.'}</Text></Box>
      )}

      <Keybindings bindings={[
        { key: '↑↓',   label: 'navigate'       },
        { key: 'Enter', label: 'run selected'   },
        { key: 'A',     label: 'run all pending'},
        { key: 'P',     label: 'set path'       },
        { key: 'Esc',   label: 'back'           },
      ]} />
    </Box>
  );
};
