import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner   from 'ink-spinner';
import { Keybindings }    from '../components/Keybindings';
import { ConfirmDialog }  from '../components/ConfirmDialog';
import { listRoles, createRole, dropRole, grantDatabase } from '../services/users';
import { listDatabases }  from '../services/database';
import { useAsync }       from '../hooks/useAsync';
import type { Navigation } from '../hooks/useNavigation';
import type { UserInfo, DatabaseInfo, Instance } from '../types';

type Mode = 'list' | 'create-name' | 'create-pass' | 'grant-db' | 'confirm-drop' | 'busy';

interface UsersScreenProps {
  nav:      Navigation;
  instance: Instance;
}

export const UsersScreen: React.FC<UsersScreenProps> = ({ nav, instance }) => {
  const [mode,       setMode]      = useState<Mode>('list');
  const [selected,   setSelected]  = useState(0);
  const [dbSel,      setDbSel]     = useState(0);
  const [newName,    setNewName]   = useState('');
  const [newPass,    setNewPass]   = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [opMsg,      setOpMsg]     = useState<string | null>(null);

  const rolesState = useAsync<UserInfo[]>(
    () => listRoles(instance),
    [instance.id, reloadTick],
  );
  const roles = rolesState.data ?? [];

  const dbsState = useAsync<DatabaseInfo[]>(
    () => (mode === 'grant-db' ? listDatabases(instance) : Promise.resolve([])),
    [instance.id, mode],
  );
  const dbs = dbsState.data ?? [];

  const reload = useCallback(() => setReloadTick(t => t + 1), []);

  const doCreate = useCallback(async () => {
    const n = newName.trim();
    const p = newPass.trim() || undefined;
    if (!n) { setMode('list'); return; }
    setMode('busy');
    setOpMsg(`Creating role "${n}"...`);
    try {
      await createRole(instance, n, { password: p || undefined, canLogin: true });
      setOpMsg(`Role "${n}" created.`);
    } catch (e: unknown) {
      setOpMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setNewName(''); setNewPass('');
      reload(); setMode('list');
    }
  }, [instance, newName, newPass, reload]);

  const doDrop = useCallback(async () => {
    const role = roles[selected];
    if (!role) return;
    setMode('busy');
    setOpMsg(`Dropping role "${role.name}"...`);
    try {
      await dropRole(instance, role.name);
      setOpMsg(`Role "${role.name}" dropped.`);
      setSelected(s => Math.max(0, s - 1));
    } catch (e: unknown) {
      setOpMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      reload(); setMode('list');
    }
  }, [instance, roles, selected, reload]);

  const doGrant = useCallback(async () => {
    const role = roles[selected];
    const db   = dbs[dbSel];
    if (!role || !db) return;
    setMode('busy');
    try {
      await grantDatabase(instance, role.name, db.name);
      setOpMsg(`Granted "${db.name}" to "${role.name}".`);
    } catch (e: unknown) {
      setOpMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMode('list');
    }
  }, [instance, roles, selected, dbs, dbSel]);

  useInput((input, key) => {
    if (mode === 'busy' || mode === 'create-name' || mode === 'create-pass') return;
    if (mode === 'confirm-drop') return; // delegate to ConfirmDialog

    if (mode === 'grant-db') {
      if (key.upArrow)   setDbSel(s => Math.max(0, s - 1));
      if (key.downArrow) setDbSel(s => Math.min(dbs.length - 1, s + 1));
      if (key.return || input === '\r') void doGrant();
      if (key.escape)    setMode('list');
      return;
    }

    if (key.upArrow)   setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(roles.length - 1, s + 1));
    if (key.escape)    nav.pop();
    if (input === 'n' || input === 'N') { setNewName(''); setNewPass(''); setMode('create-name'); }
    if (input === 'd' || input === 'D') { if (roles[selected]) setMode('confirm-drop'); }
    if (input === 'g' || input === 'G') { if (roles[selected]) { setDbSel(0); setMode('grant-db'); } }
  });

  const selectedRole = roles[selected];

  return (
    <Box flexDirection="column">
      {/* Role list */}
      <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={1} marginBottom={1}>
        <Box>
          <Text bold color="blue">{'NAME                SUPERUSER  REPLICATION  LOGIN'}</Text>
        </Box>
        <Text color="gray" dimColor>{'─'.repeat(56)}</Text>
        {rolesState.loading && (
          <Box><Text color="yellow"><Spinner type="dots" /></Text><Text color="gray">{'  Loading...'}</Text></Box>
        )}
        {!rolesState.loading && roles.length === 0 && (
          <Text color="gray" dimColor>{'  No roles found.'}</Text>
        )}
        {roles.map((r, i) => {
          const isSel = i === selected;
          const yn    = (v: boolean) => (v ? 'yes' : 'no');
          return (
            <Box key={r.name} flexDirection="row">
              <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                {`${isSel ? '▶ ' : '  '}${r.name.padEnd(20)}`}
              </Text>
              <Text color="gray">{yn(r.superuser).padEnd(11)}</Text>
              <Text color="gray">{yn(r.replication).padEnd(10)}</Text>
              <Text color="gray">{yn(r.canLogin)}</Text>
            </Box>
          );
        })}
      </Box>

      {/* Create wizard — step 1: name */}
      {mode === 'create-name' && (
        <Box borderStyle="round" borderColor="green" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'New role name: '}</Text>
          <TextInput
            value={newName}
            onChange={setNewName}
            onSubmit={() => setMode('create-pass')}
            placeholder="myuser"
          />
        </Box>
      )}

      {/* Create wizard — step 2: password */}
      {mode === 'create-pass' && (
        <Box borderStyle="round" borderColor="green" paddingX={2} marginBottom={1} flexDirection="column">
          <Box>
            <Text color="green">{'Role: '}</Text>
            <Text color="white" bold>{newName}</Text>
          </Box>
          <Box>
            <Text color="white" bold>{'Password (blank = no password): '}</Text>
            <TextInput
              value={newPass}
              onChange={setNewPass}
              onSubmit={doCreate}
              mask="*"
              placeholder=""
            />
          </Box>
        </Box>
      )}

      {/* Grant db picker */}
      {mode === 'grant-db' && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} marginBottom={1}>
          <Text bold color="yellow">{`Grant access for "${selectedRole?.name ?? ''}" to:`}</Text>
          <Text color="gray" dimColor>{'─'.repeat(40)}</Text>
          {dbsState.loading && <Box><Text color="yellow"><Spinner type="dots" /></Text></Box>}
          {dbs.map((db, i) => (
            <Box key={db.name}>
              <Text color={i === dbSel ? 'cyan' : 'white'} bold={i === dbSel}>
                {`${i === dbSel ? '▶ ' : '  '}${db.name}`}
              </Text>
            </Box>
          ))}
          <Text color="gray" dimColor>{'[Enter] grant  [Esc] cancel'}</Text>
        </Box>
      )}

      {mode === 'confirm-drop' && selectedRole && (
        <ConfirmDialog
          message={`Drop role "${selectedRole.name}"?`}
          danger
          onConfirm={() => void doDrop()}
          onCancel={() => setMode('list')}
        />
      )}

      {mode === 'busy' && (
        <Box><Text color="yellow"><Spinner type="dots" /></Text><Text color="yellow">{'  Working...'}</Text></Box>
      )}

      {!!opMsg && <Box marginBottom={1}><Text color="gray" dimColor>{`  ${opMsg}`}</Text></Box>}

      <Keybindings bindings={[
        { key: '↑↓',  label: 'navigate' },
        { key: 'N',   label: 'new role' },
        { key: 'G',   label: 'grant db' },
        { key: 'D',   label: 'drop'     },
        { key: 'Esc', label: 'back'     },
      ]} />
    </Box>
  );
};
