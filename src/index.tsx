#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { v4 as uuidv4 } from 'uuid';
import { detectPostgres } from './services/pgDetect';
import { loadConfig, upsertInstance } from './services/config';
import { App } from './App';

async function main(): Promise<void> {
  const pg = await detectPostgres();

  if (!pg) {
    process.stderr.write(
      [
        '',
        '  pgmanager: PostgreSQL client tools not found.',
        '',
        '  Make sure psql, initdb, and createdb are installed and on your PATH.',
        '  On macOS:  brew install postgresql',
        '  On Ubuntu: sudo apt install postgresql',
        '  On Windows: install from https://www.postgresql.org/download/windows/',
        '              then add C:\\Program Files\\PostgreSQL\\<version>\\bin to PATH',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  // On Windows, if a system-managed PostgreSQL service was found but hasn't
  // been imported into pgmanager yet, auto-add it so users see it immediately.
  if (process.platform === 'win32' && pg.winServiceName && pg.winDataDir) {
    const cfg = loadConfig();
    const alreadyImported = cfg.instances.some(
      i => i.dataDir === pg.winDataDir || i.winServiceName === pg.winServiceName,
    );
    if (!alreadyImported) {
      upsertInstance({
        id:             uuidv4(),
        name:           `PostgreSQL ${pg.version} (system)`,
        port:           5432,
        dataDir:        pg.winDataDir,
        superuser:      'postgres',
        createdAt:      new Date().toISOString(),
        winServiceName: pg.winServiceName,
      });
    }
  }

  // --- Alternate screen buffer ---------------------------------------------
  // Enter the terminal's alternate screen buffer so the TUI owns the whole
  // viewport and never mixes with scrollback. On exit (or any resize), we
  // also issue a full-screen clear so Ink's line-based diff can never
  // under-clear and leave ghost frames when the terminal is resized.
  const ENTER_ALT = '\x1b[?1049h';
  const LEAVE_ALT = '\x1b[?1049l';
  const CLEAR_ALL = '\x1b[2J\x1b[H';

  const isTTY = !!process.stdout.isTTY;
  if (isTTY) {
    process.stdout.write(ENTER_ALT + CLEAR_ALL);
  }

  const restoreScreen = (): void => {
    if (isTTY) process.stdout.write(LEAVE_ALT);
  };

  // Always return to the main screen on any exit path.
  process.on('exit',    restoreScreen);
  process.on('SIGINT',  () => { restoreScreen(); process.exit(130); });
  process.on('SIGTERM', () => { restoreScreen(); process.exit(143); });

  // On resize, wipe the whole screen before Ink's next diff frame runs.
  // This prevents the classic Ink ghost-frame artifact where the previous
  // frame's wrapped lines leak into scrollback.
  if (isTTY) {
    process.stdout.on('resize', () => {
      process.stdout.write(CLEAR_ALL);
    });
  }

  const { waitUntilExit } = render(
    <App pgCtlBin={pg.pgCtl} initdbBin={pg.initdb} />,
  );
  await waitUntilExit();
  restoreScreen();
}

void main();

