import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
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
import { mutedColor } from '../theme';

interface Props {
  nav: Navigation;
  /** Called after a version is successfully installed so the parent can refresh. */
  onInstalled?: (major: number) => void;
}

type Phase = 'select' | 'confirm-download' | 'confirm-remove' | 'downloading' | 'extracting' | 'removing' | 'done' | 'error';

function safeStatus(input: string): string {
  return input
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .split(/\r+/)
    .pop()!
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/** Like safeStatus but preserves line breaks — used for error messages so a
 *  multi-line diagnostic ("Full log: …", actionable hints) isn't collapsed. */
function safeMultilineStatus(input: string): string {
  return input
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .slice(0, 4000);
}

export const DownloadPgScreen: React.FC<Props> = ({ nav, onInstalled }) => {
  const [selected, setSelected] = useState(0);
  const [phase,    setPhase]    = useState<Phase>('select');
  const [message,  setMessage]  = useState('');
  const poppedRef = useRef(false);
  const [downloaded, setDownloaded] = useState(0);
  const [total,      setTotal]      = useState(0);
  const isLinux = process.platform === 'linux';

  // Slow-tick spinner (1s interval). ink-spinner updates every ~80ms which
  // causes ~12 full Ink re-renders/second over SSH — enough to cause heavy
  // terminal flicker. A 1s interval reduces that to 1 re-render/s.
  const [spinTick, setSpinTick] = useState(0);
  useEffect(() => {
    if (phase !== 'downloading' && phase !== 'extracting' && phase !== 'removing') return;
    const t = setInterval(() => setSpinTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  const SPIN_CHARS = ['|', '/', '-', '\\'];
  const spinChar = SPIN_CHARS[spinTick % SPIN_CHARS.length] ?? '|';

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
    setMessage(`${isLinux ? 'Installing' : 'Downloading'} PostgreSQL ${release.patch}…`);

    const onProgress: ProgressCallback = ({ phase: p, downloaded: d, total: t, message: m }) => {
      if (p === 'downloading') {
        setDownloaded(d);
        setTotal(t);
        // On Linux, apt streams lines via `message` (d and t stay 0).
        // Show those lines as status feedback instead of "Downloading… 0 B".
        if (m && d === 0 && t === 0) {
          setMessage(safeStatus(m));
        } else {
          setMessage(t > 0
            ? `Downloading…  ${humanBytes(d)} / ${humanBytes(t)}`
            : `Downloading…  ${humanBytes(d)}`);
        }
      } else if (p === 'extracting') {
        setPhase('extracting');
        setMessage(safeStatus(m ?? 'Extracting archive…'));
      } else if (p === 'done') {
        setMessage(safeStatus(m ?? 'Done'));
        setPhase('done');
        refreshInstalled();
        onInstalled?.(release.major);
      } else if (p === 'error') {
        setMessage(safeMultilineStatus(m ?? 'Unknown error'));
        setPhase('error');
      }
    };

    const result = await downloadVersion(release, onProgress);
    // Safety net: if downloadVersion returned an error but never emitted an
    // 'error' phase, force the UI out of the busy state so the user is never
    // left staring at a frozen progress message.
    if (!result.ok) {
      setPhase(prev => (prev === 'downloading' || prev === 'extracting') ? 'error' : prev);
      const tail = result.message || 'Install failed';
      const withLog = result.logPath && !tail.includes(result.logPath)
        ? `${tail}\nFull log: ${result.logPath}`
        : tail;
      setMessage(prev => prev || withLog);
    }
  }, [isLinux, refreshInstalled, onInstalled]);

  const doRemove = useCallback(async (release: PgRelease) => {
    setPhase('removing');
    setMessage(`Removing PostgreSQL ${release.patch}…`);

    const onProgress: ProgressCallback = ({ phase: p, message: m }) => {
      if (p === 'downloading') {
        if (m) setMessage(safeStatus(m));
      } else if (p === 'done') {
        setMessage(safeStatus(m ?? 'Removed'));
        refreshInstalled();
        setPhase('select');
      } else if (p === 'error') {
        setMessage(safeMultilineStatus(m ?? 'Remove failed'));
        setPhase('error');
      }
    };

    const result = await removeVersion(release.major, onProgress);
    refreshInstalled();
    if (result.ok) {
      // onProgress 'done' already advanced phase — but on non-Linux paths
      // there's no progress emission, so guard here too.
      setPhase(prev => (prev === 'removing' ? 'select' : prev));
    } else {
      setPhase(prev => (prev === 'removing' ? 'error' : prev));
      const tail = result.message || 'Remove failed';
      const withLog = result.logPath && !tail.includes(result.logPath)
        ? `${tail}\nFull log: ${result.logPath}`
        : tail;
      setMessage(prev => prev || withLog);
    }
  }, [refreshInstalled]);

  useInput((input, key) => {
    if (phase === 'downloading' || phase === 'extracting' || phase === 'removing') return; // no input while busy

    if (phase === 'done' || phase === 'error') {
      const hasKey = !!input || key.return || key.escape ||
        key.upArrow || key.downArrow || key.tab || key.backspace || key.delete;
      if (!hasKey) return;
      if (!poppedRef.current) { poppedRef.current = true; nav.pop(); }
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
        void doRemove(selectedRelease);
      } else {
        setPhase('select');
      }
      return;
    }

    // select phase
    if (key.escape) {
      if (!poppedRef.current) { poppedRef.current = true; nav.pop(); }
      return;
    }
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
    if (total === 0) return `[${'-'.repeat(width)}]`;
    const filled = Math.round((downloaded / total) * width);
    return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
  };

  const pct = total > 0 ? `${Math.round((downloaded / total) * 100)}%` : '';

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1}>
        <Text bold color="cyan">{'Manage PostgreSQL Versions'}</Text>
        <Text color={mutedColor}>{isLinux ? '  — installs via apt-get (PGDG)' : '  — portable installs in ~/.pgmanager/pg-versions/'}</Text>
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
                  <Text color={mutedColor}>{'  not installed'}</Text>
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
              <Text color={mutedColor}>{'Installs via apt-get. Requires internet access and may prompt for sudo.'}</Text>
              <Text color={mutedColor}>{`Binaries will be placed at /usr/lib/postgresql/${selectedRelease.major}/bin/`}</Text>
            </>
          ) : (
            <>
              <Text color={mutedColor}>{'~50–80 MB portable ZIP will be saved to ~/.pgmanager/pg-versions/'}</Text>
              <Text color={mutedColor}>{'All required DLLs / libraries included — no system install needed.'}</Text>
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
            <Text color={mutedColor}>{`Run: sudo apt remove postgresql-${selectedRelease.major}`}</Text>
          ) : (
            <Text color={mutedColor}>{'This will delete ~/.pgmanager/pg-versions/' + selectedRelease.major + '/  (the binaries only, not your data).'}</Text>
          )}
          <Box marginTop={1}>
            <Text color="white">{'  Press '}</Text>
            <Text color="red" bold>{'Y / Enter'}</Text>
            <Text color="white">{' to remove,  '}</Text>
            <Text color={mutedColor}>{'any other key'}</Text>
            <Text color="white">{' to cancel'}</Text>
          </Box>
        </Box>
      )}

      {/* Downloading / apt-installing */}
      {phase === 'downloading' && (
        <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1} flexDirection="column">
          <Box flexDirection="row">
            <Text color="cyan">{spinChar}</Text>
            <Text color="cyan" bold>{`  ${isLinux ? 'Installing' : 'Downloading'} PostgreSQL ${selectedRelease.patch}`}</Text>
          </Box>
          {!isLinux && (
            <Box marginTop={1}>
              <Text color="white">{progressBar(downloaded, total)}</Text>
              <Text color="cyan">{`  ${pct}`}</Text>
            </Box>
          )}
          <Text color={mutedColor}>{message}</Text>
        </Box>
      )}

      {/* Extracting */}
      {phase === 'extracting' && (
        <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1} flexDirection="column">
          <Box flexDirection="row">
            <Text color="cyan">{spinChar}</Text>
            <Text color="cyan" bold>{`  Extracting PostgreSQL ${selectedRelease.patch}`}</Text>
          </Box>
          <Text color={mutedColor}>{message}</Text>
        </Box>
      )}

      {/* Removing (Linux apt-get remove streams output here) */}
      {phase === 'removing' && (
        <Box borderStyle="round" borderColor="red" paddingX={2} marginBottom={1} flexDirection="column">
          <Box flexDirection="row">
            <Text color="red">{spinChar}</Text>
            <Text color="red" bold>{`  Removing PostgreSQL ${selectedRelease.patch}`}</Text>
          </Box>
          <Text color={mutedColor}>{message}</Text>
        </Box>
      )}

      {/* Done */}
      {phase === 'done' && (
        <Box borderStyle="round" borderColor="green" paddingX={2} marginBottom={1} flexDirection="column">
          <Text color="green" bold>{`✓ PostgreSQL ${selectedRelease.patch} installed successfully!`}</Text>
          <Text color={mutedColor}>{message}</Text>
          <Box marginTop={1}>
            <Text color={mutedColor}>{'You can now create a new instance using this version.  Press any key to go back.'}</Text>
          </Box>
        </Box>
      )}

      {/* Error */}
      {phase === 'error' && (() => {
        // The message is structured: first line is "Log: /path/…", then a blank,
        // then the summary + E: lines. Separate them for distinct rendering so
        // the log path is always visible at the top regardless of terminal height.
        const allLines = message.split('\n');
        const logLine  = allLines.find(l => l.startsWith('Log: ')) ?? '';
        const bodyLines = allLines
          .filter(l => !l.startsWith('Log: '))
          .filter(Boolean)  // drop blank-only lines left by the filter
          .slice(0, 10);    // cap at 10 lines — critical info is at the top
        return (
          <Box borderStyle="round" borderColor="red" paddingX={2} marginBottom={1} flexDirection="column">
            <Text color="red" bold>{'✗ Installation failed'}</Text>
            {logLine ? (
              <Text color="yellow">{logLine}</Text>
            ) : null}
            {bodyLines.map((line, i) => (
              <Text key={i} color={/^(E:|Err:|dpkg: error|error processing)/i.test(line) ? 'red' : 'red'}>
                {line}
              </Text>
            ))}
            <Box marginTop={1}>
              <Text color={mutedColor}>{'Press any key to go back. Then: cat <log path above> for full output.'}</Text>
            </Box>
          </Box>
        );
      })()}

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
