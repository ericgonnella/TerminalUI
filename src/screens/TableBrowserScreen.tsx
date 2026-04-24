import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner   from 'ink-spinner';
import { Keybindings }  from '../components/Keybindings';
import { listSchemas, listTables, describeTable, sampleRows } from '../services/tableBrowser';
import { useAsync }     from '../hooks/useAsync';
import type { Navigation }  from '../hooks/useNavigation';
import type { TableInfo, ColumnInfo, Instance } from '../types';

type Pane = 'schemas' | 'tables' | 'columns' | 'data';

interface TableBrowserScreenProps {
  nav:      Navigation;
  instance: Instance;
  database: string;
}

export const TableBrowserScreen: React.FC<TableBrowserScreenProps> = ({
  nav, instance, database,
}) => {
  const [pane,       setPane]      = useState<Pane>('schemas');
  const [schema,     setSchema]    = useState<string>('public');
  const [tableName,  setTableName] = useState<string | null>(null);
  const [selSchema,  setSelSchema] = useState(0);
  const [selTable,   setSelTable]  = useState(0);
  const [selCol,     setSelCol]    = useState(0);
  const [page,       setPage]      = useState(0);
  const PAGE_SIZE = 10;

  const schemasState = useAsync<string[]>(
    () => listSchemas(instance, database),
    [instance.id, database],
  );
  const schemas = schemasState.data ?? [];

  const tablesState = useAsync<TableInfo[]>(
    () => (schema ? listTables(instance, database, schema) : Promise.resolve([])),
    [instance.id, database, schema],
  );
  const tables = tablesState.data ?? [];

  const colsState = useAsync<ColumnInfo[]>(
    () => (tableName ? describeTable(instance, database, schema, tableName) : Promise.resolve([])),
    [instance.id, database, schema, tableName],
  );
  const cols = colsState.data ?? [];

  const rowsState = useAsync<Record<string, unknown>[]>(
    () => (pane === 'data' && tableName
      ? sampleRows(instance, database, schema, tableName, PAGE_SIZE + 1, page * PAGE_SIZE)
      : Promise.resolve([])),
    [instance.id, database, schema, tableName, pane, page],
  );
  const rows = rowsState.data ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const displayRows = rows.slice(0, PAGE_SIZE);

  useInput((input, key) => {
    if (pane === 'schemas') {
      if (key.upArrow)   setSelSchema(s => Math.max(0, s - 1));
      if (key.downArrow) setSelSchema(s => Math.min(schemas.length - 1, s + 1));
      if (key.return || input === '\r') {
        const s = schemas[selSchema];
        if (s) { setSchema(s); setSelTable(0); setTableName(null); setPane('tables'); }
      }
      if (key.escape) nav.pop();
    } else if (pane === 'tables') {
      if (key.upArrow)   setSelTable(s => Math.max(0, s - 1));
      if (key.downArrow) setSelTable(s => Math.min(tables.length - 1, s + 1));
      if (key.return || input === '\r') {
        const t = tables[selTable];
        if (t) { setTableName(t.name); setSelCol(0); setPane('columns'); }
      }
      if (key.escape) { setPane('schemas'); }
    } else if (pane === 'columns') {
      if (key.upArrow)   setSelCol(s => Math.max(0, s - 1));
      if (key.downArrow) setSelCol(s => Math.min(cols.length - 1, s + 1));
      if (input === 'd' || input === 'D') { setPage(0); setPane('data'); }
      if (key.escape) setPane('tables');
    } else if (pane === 'data') {
      if (input === 'n' || input === 'N') { if (hasMore) setPage(p => p + 1); }
      if (input === 'p' || input === 'P') setPage(p => Math.max(0, p - 1));
      if (key.escape) setPane('columns');
    }
  });

  const renderCols = () => (
    <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={1} marginBottom={1}>
      <Box>
        <Text bold color="blue">{'COLUMN              TYPE                NOT NULL  DEFAULT'}</Text>
      </Box>
      <Text color="gray" dimColor>{'─'.repeat(64)}</Text>
      {colsState.loading && <Box><Text color="yellow"><Spinner type="dots" /></Text></Box>}
      {cols.map((c, i) => {
        const isSel = i === selCol;
        return (
          <Box key={c.name} flexDirection="row">
            <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
              {`${isSel ? '▶ ' : '  '}${c.name.padEnd(20)}`}
            </Text>
            <Text color="gray">{c.dataType.padEnd(20)}</Text>
            <Text color={c.nullable ? 'gray' : 'yellow'}>{(c.nullable ? 'yes' : 'NO').padEnd(10)}</Text>
            <Text color="gray" dimColor>{c.defaultValue ?? '-'}</Text>
          </Box>
        );
      })}
    </Box>
  );

  const renderData = () => {
    const colNames = cols.map(c => c.name);
    const colWidth = 18;
    return (
      <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={1} marginBottom={1}>
        <Box>
          {colNames.slice(0, 4).map(c => (
            <Text key={c} bold color="blue">{c.substring(0, colWidth - 1).padEnd(colWidth)}</Text>
          ))}
          {colNames.length > 4 && <Text color="gray" dimColor>{'...'}</Text>}
        </Box>
        <Text color="gray" dimColor>{'─'.repeat(72)}</Text>
        {rowsState.loading && <Box><Text color="yellow"><Spinner type="dots" /></Text></Box>}
        {!rowsState.loading && displayRows.length === 0 && (
          <Text color="gray" dimColor>{'  (empty)'}</Text>
        )}
        {displayRows.map((row, ri) => (
          <Box key={ri} flexDirection="row">
            {colNames.slice(0, 4).map(c => {
              const val = row[c];
              const s   = val === null ? 'NULL' : String(val);
              return <Text key={c} color={val === null ? 'gray' : 'white'}>{s.substring(0, colWidth - 1).padEnd(colWidth)}</Text>;
            })}
          </Box>
        ))}
        <Text color="gray" dimColor>{`  Page ${page + 1}${hasMore ? '+' : ''}`}</Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      {/* Breadcrumb-like pane header */}
      <Box marginBottom={1}>
        <Text color={pane === 'schemas' ? 'cyan' : 'gray'} bold={pane === 'schemas'}>{'Schemas'}</Text>
        {pane !== 'schemas' && (
          <>
            <Text color="gray" dimColor>{' › '}</Text>
            <Text color={pane === 'tables' ? 'cyan' : 'gray'} bold={pane === 'tables'}>{schema}</Text>
          </>
        )}
        {(pane === 'columns' || pane === 'data') && (
          <>
            <Text color="gray" dimColor>{' › '}</Text>
            <Text color={pane === 'columns' ? 'cyan' : 'gray'} bold={pane === 'columns'}>{tableName}</Text>
          </>
        )}
        {pane === 'data' && (
          <>
            <Text color="gray" dimColor>{' › '}</Text>
            <Text color="cyan" bold>{'Data'}</Text>
          </>
        )}
      </Box>

      {/* Schemas pane */}
      {pane === 'schemas' && (
        <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={1} marginBottom={1}>
          <Text bold color="blue">{'SCHEMAS'}</Text>
          <Text color="gray" dimColor>{'─'.repeat(40)}</Text>
          {schemasState.loading && <Box><Text color="yellow"><Spinner type="dots" /></Text></Box>}
          {schemas.map((s, i) => {
            const isSel = i === selSchema;
            return (
              <Box key={s}>
                <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                  {`${isSel ? '▶ ' : '  '}${s}`}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Tables pane */}
      {pane === 'tables' && (
        <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={1} marginBottom={1}>
          <Box>
            <Text bold color="blue">{'TABLE               ROWS (EST)   SIZE'}</Text>
          </Box>
          <Text color="gray" dimColor>{'─'.repeat(50)}</Text>
          {tablesState.loading && <Box><Text color="yellow"><Spinner type="dots" /></Text></Box>}
          {!tablesState.loading && tables.length === 0 && (
            <Text color="gray" dimColor>{'  No tables in this schema.'}</Text>
          )}
          {tables.map((t, i) => {
            const isSel = i === selTable;
            return (
              <Box key={t.name} flexDirection="row">
                <Text color={isSel ? 'cyan' : 'white'} bold={isSel}>
                  {`${isSel ? '▶ ' : '  '}${t.name.padEnd(20)}`}
                </Text>
                <Text color="gray">{String(t.rowEstimate ?? '-').padEnd(13)}</Text>
                <Text color="gray">{t.sizePretty ?? '-'}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Columns pane */}
      {pane === 'columns' && renderCols()}

      {/* Data pane */}
      {pane === 'data' && renderData()}

      <Keybindings bindings={
        pane === 'data'
          ? [{ key: 'N', label: 'next page' }, { key: 'P', label: 'prev page' }, { key: 'Esc', label: 'back' }]
          : pane === 'columns'
          ? [{ key: '↑↓', label: 'navigate' }, { key: 'D', label: 'view data' }, { key: 'Esc', label: 'back' }]
          : [{ key: '↑↓', label: 'navigate' }, { key: 'Enter', label: 'open' }, { key: 'Esc', label: 'back' }]
      } />
    </Box>
  );
};
