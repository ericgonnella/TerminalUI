import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner   from 'ink-spinner';
import { Keybindings }      from '../components/Keybindings';
import { ConfirmDialog }    from '../components/ConfirmDialog';
import { PeekPasswordInput } from '../components/PeekPasswordInput';
import {
  getDatabaseDetail,
  renameDatabase,
  changeOwner,
  type DatabaseDetail,
} from '../services/database';
import { changeRolePassword, listRoles } from '../services/users';
import { useAsync }       from '../hooks/useAsync';
import type { Navigation } from '../hooks/useNavigation';
import type { Instance }  from '../types';

type Mode =
  | 'view'
  | 'edit-name'
  | 'edit-owner'
  | 'edit-password'
  | 'edit-password-confirm'
  | 'confirm-rename'
  | 'busy';

interface Props {
  nav:      Navigation;
  instance: Instance;
  database: string;
}

export const DatabaseDetailScreen: React.FC<Props> = ({ nav, instance, database }) => {
  const [mode,       setMode]       = useState<Mode>('view');
  const [reloadTick, setReloadTick] = useState(0);
  const [opMsg,      setOpMsg]      = useState<string | null>(null);
  const [opError,    setOpError]    = useState<string | null>(null);

  // Edit field buffers
  const [editName,            setEditName]            = useState('');
  const [editOwner,           setEditOwner]           = useState('');
  const [editPassword,        setEditPassword]        = useState('');
  const [editPasswordConfirm, setEditPasswordConfirm] = useState('');
  const [editPasswordError,   setEditPasswordError]   = useState<string | null>(null);

  // Current database name may change after a rename
  const [currentDb, setCurrentDb] = useState(database);

  const reload = useCallback(() => {
    setReloadTick(t => t + 1);
    setOpError(null);
  }, []);

  const detailState = useAsync<DatabaseDetail>(
    () => getDatabaseDetail(instance, currentDb),
    [instance.id, currentDb, reloadTick],
  );
  const detail = detailState.data;

  // Roles for owner autocomplete hint (not enforced, just shown as hint)
  const rolesState = useAsync(
    () => listRoles(instance),
    [instance.id],
  );
  const roles = (rolesState.data ?? []).map(r => r.name);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const startEditName = useCallback(() => {
    setEditName(currentDb);
    setOpMsg(null);
    setOpError(null);
    setMode('edit-name');
  }, [currentDb]);

  const startEditOwner = useCallback(() => {
    setEditOwner(detail?.owner ?? '');
    setOpMsg(null);
    setOpError(null);
    setMode('edit-owner');
  }, [detail]);

  const startEditPassword = useCallback(() => {
    setEditPassword('');
    setEditPasswordConfirm('');
    setEditPasswordError(null);
    setOpMsg(null);
    setOpError(null);
    setMode('edit-password');
  }, []);

  const handlePasswordFirstSubmit = useCallback((value: string) => {
    if (!value.trim()) { setMode('view'); return; }
    setEditPassword(value);
    setEditPasswordConfirm('');
    setEditPasswordError(null);
    setMode('edit-password-confirm');
  }, []);

  const handlePasswordConfirmSubmit = useCallback(async (value: string) => {
    if (value !== editPassword) {
      setEditPasswordError('Passwords do not match \u2014 please try again.');
      setEditPassword('');
      setEditPasswordConfirm('');
      setMode('edit-password');
      return;
    }
    if (!detail?.owner) { setMode('view'); return; }
    setMode('busy');
    setOpMsg(`Changing password for role "${detail.owner}"...`);
    try {
      await changeRolePassword(instance, detail.owner, editPassword);
      setOpMsg(`Password for "${detail.owner}" updated.`);
      setOpError(null);
    } catch (e: unknown) {
      setOpError(e instanceof Error ? e.message : String(e));
      setOpMsg(null);
    } finally {
      setEditPassword('');
      setEditPasswordConfirm('');
      setMode('view');
    }
  }, [editPassword, instance, detail]);

  const doRename = useCallback(async () => {
    const newName = editName.trim();
    if (!newName || newName === currentDb) { setMode('view'); return; }
    setMode('busy');
    setOpMsg(`Renaming database to "${newName}"...`);
    try {
      await renameDatabase(instance, currentDb, newName);
      setCurrentDb(newName);
      setOpMsg(`Database renamed to "${newName}".`);
      setOpError(null);
    } catch (e: unknown) {
      setOpError(e instanceof Error ? e.message : String(e));
      setOpMsg(null);
    } finally {
      reload();
      setMode('view');
    }
  }, [instance, currentDb, editName, reload]);

  const doChangeOwner = useCallback(async (value: string) => {
    const newOwner = value.trim();
    if (!newOwner) { setMode('view'); return; }
    setMode('busy');
    setOpMsg(`Changing owner to "${newOwner}"...`);
    try {
      await changeOwner(instance, currentDb, newOwner);
      setOpMsg(`Owner changed to "${newOwner}".`);
      setOpError(null);
    } catch (e: unknown) {
      setOpError(e instanceof Error ? e.message : String(e));
      setOpMsg(null);
    } finally {
      reload();
      setMode('view');
    }
  }, [instance, currentDb, reload]);

  // ── Keybindings ─────────────────────────────────────────────────────────────

  useInput((input, key) => {
    if (mode === 'busy') return;
    if (key.escape) {
      if (mode !== 'view') { setMode('view'); return; }
      nav.pop();
      return;
    }
    if (mode !== 'view') return;
    if (input === 'r' || input === 'R') startEditName();
    if (input === 'o' || input === 'O') startEditOwner();
    if (input === 'p' || input === 'P') startEditPassword();
    if (key.return) {
      // Enter → browse tables
      nav.push({ name: 'table-browser', instance, database: currentDb });
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const connLimitLabel = (n: number) => (n === -1 ? 'unlimited' : String(n));

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column">
      {/* Detail panel */}
      <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={2} marginBottom={1}>
        <Box flexDirection="row" marginBottom={0}>
          <Text bold color="blue">{'Database: '}</Text>
          <Text bold color="cyan">{currentDb}</Text>
        </Box>
        <Text color="gray">{'─'.repeat(54)}</Text>

        {detailState.loading && (
          <Box><Text color="yellow"><Spinner type="dots" /></Text><Text color="gray">{'  Loading...'}</Text></Box>
        )}
        {!!detailState.error && (
          <Text color="red">{`  Error: ${detailState.error}`}</Text>
        )}

        {!!detail && (
          <>
            <Box flexDirection="row">
              <Text color="gray">{'Owner:            '}</Text>
              <Text color="white">{detail.owner}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Encoding:         '}</Text>
              <Text color="white">{detail.encoding}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Collation:        '}</Text>
              <Text color="white">{detail.collation}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Locale (LC_CTYPE): '}</Text>
              <Text color="white">{detail.ctypeLocale}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Tablespace:       '}</Text>
              <Text color="white">{detail.tablespace}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Size:             '}</Text>
              <Text color="green">{detail.sizePretty}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Active connections: '}</Text>
              <Text color={detail.activeConnections > 0 ? 'yellow' : 'white'}>
                {String(detail.activeConnections)}
              </Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Connection limit: '}</Text>
              <Text color="white">{connLimitLabel(detail.connectionLimit)}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Allow connections: '}</Text>
              <Text color={detail.allowConnections ? 'green' : 'red'}>
                {detail.allowConnections ? 'yes' : 'no'}
              </Text>
            </Box>
            <Box flexDirection="row">
              <Text color="gray">{'Is template:      '}</Text>
              <Text color="white">{detail.isTemplate ? 'yes' : 'no'}</Text>
            </Box>
          </>
        )}
      </Box>

      {/* ── Edit: Rename ──────────────────────────────────────────────────── */}
      {mode === 'edit-name' && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="yellow" bold>{'Rename database'}</Text>
          <Text color="gray" dimColor>{'Press Enter to confirm, Esc to cancel.'}</Text>
          <Box flexDirection="row" marginTop={1}>
            <Text color="white">{'New name: '}</Text>
            <TextInput
              value={editName}
              onChange={setEditName}
              onSubmit={() => void doRename()}
              placeholder={currentDb}
            />
          </Box>
        </Box>
      )}

      {/* ── Edit: Change owner ────────────────────────────────────────────── */}
      {mode === 'edit-owner' && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="yellow" bold>{'Change owner'}</Text>
          {roles.length > 0 && (
            <Text color="gray" dimColor>{`Roles: ${roles.slice(0, 8).join(', ')}${roles.length > 8 ? ', …' : ''}`}</Text>
          )}
          <Text color="gray" dimColor>{'Press Enter to confirm, Esc to cancel.'}</Text>
          <Box flexDirection="row" marginTop={1}>
            <Text color="white">{'New owner: '}</Text>
            <TextInput
              value={editOwner}
              onChange={setEditOwner}
              onSubmit={doChangeOwner}
              placeholder={detail?.owner ?? 'postgres'}
            />
          </Box>
        </Box>
      )}

      {/* ── Edit: Change password ─────────────────────────────────────────── */}
      {(mode === 'edit-password' || mode === 'edit-password-confirm') && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="yellow" bold>{`Change password for owner "${detail?.owner ?? '?'}"`}</Text>
          <Text color="gray" dimColor>{'Press Enter to confirm, Esc to cancel.'}</Text>
          <Box flexDirection="row" marginTop={1}>
            <Text color={mode === 'edit-password' ? 'white' : 'gray'}>
              {'New password:     '}
            </Text>
            {mode === 'edit-password' ? (
              <PeekPasswordInput
                value={editPassword}
                onChange={setEditPassword}
                onSubmit={handlePasswordFirstSubmit}
                placeholder="(leave blank to cancel)"
              />
            ) : (
              <Text color="green">{'*'.repeat(Math.min(editPassword.length, 12))}</Text>
            )}
          </Box>
          {mode === 'edit-password' && !!editPasswordError && (
            <Text color="red">{'  ✗ '}{editPasswordError}</Text>
          )}
          {mode === 'edit-password-confirm' && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color="white" bold>{'Confirm password: '}</Text>
                <PeekPasswordInput
                  value={editPasswordConfirm}
                  onChange={setEditPasswordConfirm}
                  onSubmit={handlePasswordConfirmSubmit}
                  placeholder="re-enter your password"
                />
              </Box>
            </Box>
          )}
        </Box>
      )}

      {/* ── Busy ──────────────────────────────────────────────────────────── */}
      {mode === 'busy' && (
        <Box marginBottom={1}>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text color="yellow">{`  ${opMsg ?? 'Working...'}`}</Text>
        </Box>
      )}

      {/* ── Status messages ───────────────────────────────────────────────── */}
      {mode === 'view' && !!opMsg && (
        <Box marginBottom={1}>
          <Text color="green">{`  ✓ ${opMsg}`}</Text>
        </Box>
      )}
      {mode === 'view' && !!opError && (
        <Box borderStyle="round" borderColor="red" paddingX={2} marginBottom={1}>
          <Text color="red">{`Error: ${opError}`}</Text>
        </Box>
      )}

      {/* ── Keybindings ───────────────────────────────────────────────────── */}
      {mode === 'view' && (
        <Keybindings bindings={[
          { key: 'Enter', label: 'browse tables' },
          { key: 'R',     label: 'rename'        },
          { key: 'O',     label: 'change owner'  },
          { key: 'P',     label: 'change password'},
          { key: 'Esc',   label: 'back'          },
        ]} />
      )}
      {(mode === 'edit-name' || mode === 'edit-owner' || mode === 'edit-password' || mode === 'edit-password-confirm') && (
        <Keybindings bindings={[
          { key: 'Enter', label: 'confirm' },
          { key: 'Esc',   label: 'cancel'  },
        ]} />
      )}
    </Box>
  );
};
