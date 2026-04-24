import React from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize';

export interface KeyBinding {
  key:   string;
  label: string;
}

interface KeybindingsProps {
  bindings: KeyBinding[];
}

/**
 * Width of a single binding chip:
 *   "[key] label"   →  key.length + 2 (brackets) + 1 (space) + label.length
 *   "[key]"         →  key.length + 2                (compact mode)
 */
function chipWidth(b: KeyBinding, compact: boolean): number {
  return b.key.length + 2 + (compact ? 0 : 1 + b.label.length);
}

/** Pack chips into rows; each row fits inside `maxWidth` columns. */
function packRows(
  bindings: KeyBinding[],
  maxWidth: number,
  compact: boolean,
): KeyBinding[][] {
  const SEP = 2;
  const rows: KeyBinding[][] = [];
  let row: KeyBinding[]      = [];
  let rowW                   = 0;

  for (const b of bindings) {
    const w      = chipWidth(b, compact);
    const needed = row.length === 0 ? w : SEP + w;
    if (row.length > 0 && rowW + needed > maxWidth) {
      rows.push(row);
      row  = [b];
      rowW = w;
    } else {
      row.push(b);
      rowW += needed;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

export const Keybindings: React.FC<KeybindingsProps> = ({ bindings }) => {
  const { columns } = useTerminalSize();

  // Reserve a small margin so we never fight Ink's parent-box shrink behaviour.
  const usable = Math.max(10, columns - 2);

  // If even a single full chip wouldn't fit on a line, drop labels.
  const widest      = bindings.reduce((m, b) => Math.max(m, chipWidth(b, false)), 0);
  const compact     = widest > usable;

  const rows = packRows(bindings, usable, compact);

  return (
    <Box flexDirection="column" marginTop={0}>
      {rows.map((row, ri) => (
        <Box key={ri} flexDirection="row">
          {row.map((b, i) => (
            // `flexShrink={0}` stops Ink from compressing a chip and
            // breaking words like "navigat"/"Ente"/"instanc".
            <Box key={i} flexShrink={0} flexDirection="row" marginRight={2}>
              <Text color="cyan" bold wrap="truncate-end">{`[${b.key}]`}</Text>
              {!compact && (
                <Text color="gray" wrap="truncate-end">{` ${b.label}`}</Text>
              )}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
};

