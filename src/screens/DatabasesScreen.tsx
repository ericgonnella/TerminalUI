import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner   from 'ink-spinner';
import { Keybindings }      from '../components/Keybindings';
import { ConfirmDialog }    from '../components/ConfirmDialog';
import { listDatabases, createDatabase, dropDatabase } from '../services/database';
import { useAsync }         from '../hooks/useAsync';
import type { Navigation }  from '../hooks/useNavigation';
import type { DatabaseInfo, Instance } from '../types';
import { mutedColor } from '../theme';

type Mode = 'list' | 'create-name' | 'confirm-drop' | 'busy';

interface DatabasesScreenProps {
  nav:      Navigation;
  instance: Instance;
  /** If provided, this database is pre-selected on open */
  database?: string;
}

export const DatabasesScreen: React.FC<DatabasesScreenProps> = ({
  nav, instance, database: initialDb,
}) => {
  const [mode,      setMode]     = useState<Mode>('list');
  const [selected,  setSelected] = useState(0);
  const [newName,   setNewName]  = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [opMsg,     setOpMsg]    = useState<string | null>(null);

  const dbState = useAsync<DatabaseInfo[]>(
    () => listDatabases(instance),
    [instance.id, reloadTick],
  );
  const dbs = dbState.data ?? [];

  // Pre-select initialDb when data loads
  React.useEffect(() => {
    if (initialDb && dbs.length > 0) {
      const idx = dbs.findIndex(d => d.name === initialDb);
      if (idx >= 0) setSelected(idx);
    }
  }, [initialDb, dbs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => setReloadTick(t => t + 1), []);

  const doCreate = useCallback(async (name: string) => {
    const n = name.trim();
    if (!n) { setMode('list'); return; }
    setMode('busy');
    setOpMsg(`Creating database "${n}"...`);
    try {
      await createDatabase(instance, n);
      setOpMsg(`Database "${n}" created.`);
    } catch (e: unknown) {
      setOpMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setNewName('');
      reload();
      setMode('list');
    }
  }, [instance, reload]);

  const doDrop = useCallback(async () => {
    const db = dbs[selected];
    if (!db) return;
    setMode('busy');
    setOpMsg(`Dropping database "${db.name}"...`);
    try {
      await dropDatabase(instance, db.name);
      setOpMsg(`Database "${db.name}" dropped.`);
      setSelected(s => Math.max(0, s - 1));
    } catch (e: unknown) {
      setOpMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      reload();
      setMode('list');
    }
  }, [dbs, selected, instance, reload]);

  useInput((input, key) => {
    if (mode === 'busy' || mode === 'confirm-drop' || mode === 'create-name') return;
    if (key.upArrow)   setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(dbs.length - 1, s + 1));
    if (key.escape)    nav.pop();
    if (input === 'n' || input === 'N') { setNewName(''); setMode('create-name'); }
    if (input === 'd' || input === 'D') { if (dbs[selected]) setMode('confirm-drop'); }
    if (input === 'i' || input === 'I') {
      if (dbs[selected]) nav.push({ name: 'database-detail', instance, database: dbs[selected]!.name });
    }
    if ((key.return || input === '\r') && dbs[selected]) {
      nav.push({ name: 'table-browser', instance, database: dbs[selected]!.name });
    }
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={1} marginBottom={1}>
        <Box>
          <Text bold color="blue">{'NAME                OWNER           SIZE'}</Text>
        </Box>
        <Text color={mutedColor}>{'─'.repeat(60)}</Text>
        {dbState.loading && (
          <Box><Text color="yellow"><Spinner type="dots" /></Text><Text color={mutedColor}>{'  Loading...'}</Text></Box>
        )}
        {dbState.error && <Text color="red">{`  Error: ${dbState.error}`}</Text>}
        {!dbState.loading && dbs.length === 0 && (
          <Text color={mutedColor}>{'  No user databases.'}</Text>
        )}
        {dbs.map((db, i) => {
          const isSel = i === selected;
          return (
            <Box key={db.name} flexDirection="row">
              <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                {`${isSel ? '▶ ' : '  '}${db.name.padEnd(20)}`}
              </Text>
              <Text color={mutedColor}>{db.owner.padEnd(16)}</Text>
              <Text color={mutedColor}>{db.sizePretty.padEnd(12)}</Text>

            </Box>
          );
        })}
      </Box>

      {mode === 'create-name' && (
        <Box borderStyle="round" borderColor="green" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'New database name: '}</Text>
          <TextInput
            value={newName}
            onChange={setNewName}
            onSubmit={doCreate}
            placeholder="mydb"
          />
        </Box>
      )}

      {mode === 'confirm-drop' && dbs[selected] && (
        <ConfirmDialog
          message={`Drop database "${dbs[selected]!.name}"? All data will be lost.`}
          danger
          onConfirm={() => void doDrop()}
          onCancel={() => setMode('list')}
        />
      )}

      {mode === 'busy' && (
        <Box>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text color="yellow">{'  Working...'}</Text>
        </Box>
      )}

      {!!opMsg && <Box marginBottom={1}><Text color={mutedColor}>{`  ${opMsg}`}</Text></Box>}

      <Keybindings bindings={[
        { key: '↑↓',   label: 'navigate'      },
        { key: 'Enter', label: 'browse tables' },
        { key: 'I',     label: 'info / edit'   },
        { key: 'N',     label: 'new db'        },
        { key: 'D',     label: 'drop db'       },
        { key: 'Esc',   label: 'back'          },
      ]} />
    </Box>
  );
};
