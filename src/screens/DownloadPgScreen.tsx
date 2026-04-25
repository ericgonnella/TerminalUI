import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { Keybindings } from '../components/Keybindings';
import {
  PG_RELEASES,
  PgRelease,
  downloadVersion,
  managedBinDir,
  removeVersion,
  humanBytes,
  ProgressCallback,
} from '../services/pgVersions';
import type { Navigation } from '../hooks/useNavigation';

interface Props {
  nav: Navigation;
  /** Called after a version is successfully installed so the parent can refresh. */
  onInstalled?: (major: number) => void;
}

type Phase = 'select' | 'confirm-download' | 'confirm-remove' | 'downloading' | 'done' | 'error';

export const DownloadPgScreen: React.FC<Props> = ({ nav, onInstalled }) => {
  const [selected, setSelected] = useState(0);
  const [phase,    setPhase]    = useState<Phase>('select');
  const [message,  setMessage]  = useState('');
  const [downloaded, setDownloaded] = useState(0);
  const [total,      setTotal]      = useState(0);
  const poppedRef = useRef(false);
  const isLinux = process.platform === 'linux';

  // Check which majors are already installed
  const [installedMajors, setInstalledMajors] = useState<Set<number>>(new Set());

  const refreshInstalled = useCallback(() => {
    const set = new Set(
      PG_RELEASES
        .map(r => r.major)
        .filter(m => managedBinDir(m) !== null),
    );
    setInstalledMajors(set);
  }, []);

  useEffect(() => { refreshInstalled(); }, [refreshInstalled]);

  const selectedRelease: PgRelease = PG_RELEASES[selected]!;
  const isInstalled = installedMajors.has(selectedRelease?.major ?? -1);

  const startDownload = useCallback(async (release: PgRelease) => {
    setPhase('downloading');
    setDownloaded(0);
    setTotal(0);
    setMessage(`Downloading PostgreSQL ${release.patch}…`);

    const onProgress: ProgressCallback = ({ phase: p, downloaded: d, total: t, message: m }) => {
      if (p === 'downloading') {
        setDownloaded(d);
        setTotal(t);
        setMessage(t > 0
          ? `Downloading…  ${humanBytes(d)} / ${humanBytes(t)}`
          : `Downloading…  ${humanBytes(d)}`);
      } else if (p === 'extracting') {
        setMessage('Extracting archive…');
      } else if (p === 'done') {
        setMessage(m ?? 'Done');
        setPhase('done');
        refreshInstalled();
        onInstalled?.(release.major);
      } else if (p === 'error') {
        setMessage(m ?? 'Unknown error');
        setPhase('error');
      }
    };

    await downloadVersion(release, onProgress);
  }, [refreshInstalled, onInstalled]);

  const doRemove = useCallback((release: PgRelease) => {
    removeVersion(release.major);
    refreshInstalled();
    setPhase('select');
  }, [refreshInstalled]);

  useInput((input, key) => {
    if (phase === 'downloading') return; // no input while busy

    if (phase === 'done' || phase === 'error') {
      const hasKey = !!input || key.return || key.escape ||
        key.upArrow || key.downArrow || key.tab || key.backspace || key.delete;
      if (!hasKey) return;
      if (poppedRef.current) return;
      poppedRef.current = true;
      nav.pop();
      return;
    }

    if (phase === 'confirm-download') {
      if (input === 'y' || input === 'Y' || key.return) {
        void startDownload(selectedRelease);
      } else {
        setPhase('select');
      }
      return;
    }

    if (phase === 'confirm-remove') {
      if (input === 'y' || input === 'Y' || key.return) {
        doRemove(selectedRelease);
      } else {
        setPhase('select');
      }
      return;
    }

    // select phase
    if (key.escape) { nav.pop(); return; }
    if (key.upArrow)   setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(PG_RELEASES.length - 1, s + 1));

    if (key.return || input === '\r') {
      setPhase(isInstalled ? 'confirm-remove' : 'confirm-download');
    }
    if (input === 'd' || input === 'D') {
      if (isInstalled) setPhase('confirm-remove');
    }
    if (input === 'i' || input === 'I') {
      if (!isInstalled) setPhase('confirm-download');
    }
  });

  // ── Progress bar ────────────────────────────────────────────────────────────
  const progressBar = (downloaded: number, total: number, width = 40): string => {
    if (total === 0) return `[${'░'.repeat(width)}]`;
    const filled = Math.round((downloaded / total) * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
  };

  const pct = total > 0 ? `${Math.round((downloaded / total) * 100)}%` : '';

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1}>
        <Text bold color="cyan">{'Manage PostgreSQL Versions'}</Text>
        <Text color="gray" dimColor>{isLinux ? '  — installs via apt-get (PGDG)' : '  — portable installs in ~/.pgmanager/pg-versions/'}</Text>
      </Box>

      {/* Version list (shown during select phase) */}
      {(phase === 'select' || phase === 'confirm-download' || phase === 'confirm-remove') && (
        <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={1} marginBottom={1}>
          {PG_RELEASES.map((release, i) => {
            const inst  = installedMajors.has(release.major);
            const isSel = i === selected;
            return (
              <Box key={release.major} flexDirection="row">
                <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                  {`${isSel ? '▶ ' : '  '}`}
                </Text>
                <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                  {release.label.padEnd(36)}
                </Text>
                {inst ? (
                  <Text color="green" bold>{'✓ installed'}</Text>
                ) : (
                  <Text color="gray" dimColor>{'  not installed'}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Confirm download */}
      {phase === 'confirm-download' && (
        <Box borderStyle="round" borderColor="yellow" paddingX={2} marginBottom={1} flexDirection="column">
          <Text color="yellow" bold>{`${isLinux ? 'Install' : 'Download'} PostgreSQL ${selectedRelease.patch}?`}</Text>
          {isLinux ? (
            <>
              <Text color="gray" dimColor>{'Installs via apt-get. Requires internet access and may prompt for sudo.'}</Text>
              <Text color="gray" dimColor>{`Binaries will be placed at /usr/lib/postgresql/${selectedRelease.major}/bin/`}</Text>
            </>
          ) : (
            <>
              <Text color="gray" dimColor>{'~50–80 MB portable ZIP will be saved to ~/.pgmanager/pg-versions/'}</Text>
              <Text color="gray" dimColor>{'All required DLLs / libraries included — no system install needed.'}</Text>
            </>
          )}
          <Box marginTop={1}>
            <Text color="white">{'  Press '}</Text>
            <Text color="green" bold>{'Y / Enter'}</Text>
            <Text color="white">{' to download,  '}</Text>
            <Text color="red" bold>{'any other key'}</Text>
            <Text color="white">{' to cancel'}</Text>
          </Box>
        </Box>
      )}

      {/* Confirm remove */}
      {phase === 'confirm-remove' && (
        <Box borderStyle="round" borderColor="red" paddingX={2} marginBottom={1} flexDirection="column">
          <Text color="red" bold>{`Remove PostgreSQL ${selectedRelease.patch}?`}</Text>
          {isLinux ? (
            <Text color="gray" dimColor>{`Run: sudo apt remove postgresql-${selectedRelease.major}`}</Text>
          ) : (
            <Text color="gray" dimColor>{'This will delete ~/.pgmanager/pg-versions/' + selectedRelease.major + '/  (the binaries only, not your data).'}</Text>
          )}
          <Box marginTop={1}>
            <Text color="white">{'  Press '}</Text>
            <Text color="red" bold>{'Y / Enter'}</Text>
            <Text color="white">{' to remove,  '}</Text>
            <Text color="gray">{'any other key'}</Text>
            <Text color="white">{' to cancel'}</Text>
          </Box>
        </Box>
      )}

      {/* Downloading */}
      {phase === 'downloading' && (
        <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1} flexDirection="column">
          <Box flexDirection="row">
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text color="cyan" bold>{`  ${isLinux ? 'Installing' : 'Downloading'} PostgreSQL ${selectedRelease.patch}`}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="white">{progressBar(downloaded, total)}</Text>
            <Text color="cyan">{`  ${pct}`}</Text>
          </Box>
          <Text color="gray" dimColor>{message}</Text>
        </Box>
      )}

      {/* Done */}
      {phase === 'done' && (
        <Box borderStyle="round" borderColor="green" paddingX={2} marginBottom={1} flexDirection="column">
          <Text color="green" bold>{`✓ PostgreSQL ${selectedRelease.patch} installed successfully!`}</Text>
          <Text color="gray" dimColor>{message}</Text>
          <Box marginTop={1}>
            <Text color="gray">{'You can now create a new instance using this version.  Press any key to go back.'}</Text>
          </Box>
        </Box>
      )}

      {/* Error */}
      {phase === 'error' && (
        <Box borderStyle="round" borderColor="red" paddingX={2} marginBottom={1} flexDirection="column">
          <Text color="red" bold>{'✗ Installation failed'}</Text>
          {message.split('\n').filter(Boolean).map((line, i) => (
            <Text key={i} color="red" dimColor>{line}</Text>
          ))}
          <Box marginTop={1}>
            <Text color="gray">{'Press any key to go back.'}</Text>
          </Box>
        </Box>
      )}

      {phase === 'select' && (
        <Keybindings bindings={[
          { key: '↑↓',   label: 'navigate' },
          { key: 'Enter', label: isInstalled ? 'remove' : 'install' },
          { key: 'I',     label: 'install' },
          { key: 'D',     label: 'remove' },
          { key: 'Esc',   label: 'back' },
        ]} />
      )}
    </Box>
  );
};
