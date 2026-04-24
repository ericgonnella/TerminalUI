import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner   from 'ink-spinner';
import { Keybindings }  from '../components/Keybindings';
import type { Navigation } from '../hooks/useNavigation';
import type { Instance }   from '../types';
import { Pool }            from 'pg';

interface QueryScreenProps {
  nav:      Navigation;
  instance: Instance;
  database: string;
}

type Mode = 'input' | 'running' | 'results' | 'error';

interface QueryResult {
  columns:  string[];
  rows:     Record<string, unknown>[];
  rowCount: number;
  duration: number; // ms
}

export const QueryScreen: React.FC<QueryScreenProps> = ({ nav, instance, database }) => {
  const [mode,   setMode]   = useState<Mode>('input');
  const [query,  setQuery]  = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [rowPage, setRowPage] = useState(0);
  const PAGE_SIZE = 12;

  const doRun = useCallback(async (sql: string) => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    setMode('running');
    setResult(null);
    setError(null);
    setRowPage(0);

    const pool = new Pool({
      host:     '127.0.0.1',
      port:     instance.port,
      user:     instance.superuser,
      database: database,
    });

    const start = Date.now();
    try {
      const res = await pool.query(trimmed);
      const duration = Date.now() - start;
      const columns = res.fields?.map(f => f.name) ?? [];
      const rows    = (res.rows as Record<string, unknown>[]) ?? [];
      setResult({ columns, rows, rowCount: res.rowCount ?? rows.length, duration });
      setMode('results');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setMode('error');
    } finally {
      await pool.end();
    }
  }, [instance, database]);

  useInput((input, key) => {
    if (mode === 'running') return;
    if (mode === 'results') {
      if (input === 'n' || input === 'N') {
        if (result && (rowPage + 1) * PAGE_SIZE < result.rows.length) setRowPage(p => p + 1);
      }
      if (input === 'p' || input === 'P') setRowPage(p => Math.max(0, p - 1));
      if (input === 'e' || input === 'E') setMode('input');
      if (key.escape) nav.pop();
      return;
    }
    if (mode === 'error') {
      if (key.escape) nav.pop();
      if (input === 'e' || input === 'E') setMode('input');
      return;
    }
    // input mode: Esc goes back
    if (key.escape) nav.pop();
  });

  const displayRows = result?.rows.slice(rowPage * PAGE_SIZE, (rowPage + 1) * PAGE_SIZE) ?? [];
  const COL_W = 20;

  return (
    <Box flexDirection="column">
      {/* Query input box */}
      {(mode === 'input' || mode === 'running') && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text bold color="cyan">{`Query  ›  ${database}`}</Text>
          <Text color="gray" dimColor>{'─'.repeat(60)}</Text>
          <TextInput
            value={query}
            onChange={setQuery}
            onSubmit={doRun}
            placeholder="SELECT * FROM …"
          />
          {mode === 'running' && (
            <Box marginTop={1}>
              <Text color="yellow"><Spinner type="dots" /></Text>
              <Text color="yellow">{'  Running...'}</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Results */}
      {mode === 'results' && result && (
        <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={1} marginBottom={1}>
          <Box>
            <Text bold color="green">{`${result.rowCount} rows`}</Text>
            <Text color="gray" dimColor>{`  (${result.duration}ms)`}</Text>
          </Box>
          <Text color="gray" dimColor>{'─'.repeat(72)}</Text>
          {/* Header */}
          <Box>
            {result.columns.slice(0, 4).map(c => (
              <Text key={c} bold color="blue">{c.substring(0, COL_W - 1).padEnd(COL_W)}</Text>
            ))}
            {result.columns.length > 4 && <Text color="gray" dimColor>{'…'}</Text>}
          </Box>
          {/* Rows */}
          {displayRows.map((row, ri) => (
            <Box key={ri} flexDirection="row">
              {result.columns.slice(0, 4).map(c => {
                const v = row[c];
                const s = v === null ? 'NULL' : v === undefined ? '' : String(v);
                return (
                  <Text key={c} color={v === null ? 'gray' : 'white'}>
                    {s.substring(0, COL_W - 1).padEnd(COL_W)}
                  </Text>
                );
              })}
            </Box>
          ))}
          <Text color="gray" dimColor>{`  Page ${rowPage + 1} / ${Math.ceil(result.rows.length / PAGE_SIZE)}`}</Text>
        </Box>
      )}

      {/* Error */}
      {mode === 'error' && error && (
        <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text bold color="red">{'Query Error'}</Text>
          <Text color="red" dimColor>{error}</Text>
        </Box>
      )}

      <Keybindings bindings={
        mode === 'results'
          ? [{ key: 'E', label: 'edit query' }, { key: 'N/P', label: 'page' }, { key: 'Esc', label: 'back' }]
          : mode === 'error'
          ? [{ key: 'E', label: 'edit query' }, { key: 'Esc', label: 'back' }]
          : [{ key: 'Enter', label: 'run' }, { key: 'Esc', label: 'back' }]
      } />
    </Box>
  );
};
