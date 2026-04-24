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

  render(
    <App pgCtlBin={pg.pgCtl} initdbBin={pg.initdb} />,
  );
}

void main();

