import React from 'react';
import { Box, Text } from 'ink';
import type { LogEntry } from '../types';
import { getLevelColor } from '../theme';

const LEVEL_LABEL: Record<string, string> = {
  INFO:  'INFO ',
  WARN:  'WARN ',
  ERROR: 'ERROR',
  DEBUG: 'DEBUG',
};

interface ActivityLogProps {
  logs:     LogEntry[];
  maxLines?: number;
}

export const ActivityLog: React.FC<ActivityLogProps> = ({ logs, maxLines = 6 }) => {
  const visible = logs.slice(-maxLines);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={0}>
        <Text bold color="white">
          {'  Activity Log'}
        </Text>
      </Box>
      <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1}>
        {visible.length === 0 ? (
          <Text color="gray" dimColor>
            {'  Waiting for events...'}
          </Text>
        ) : (
          visible.map(entry => {
            const levelColor = getLevelColor(entry.level);
            const label      = LEVEL_LABEL[entry.level] ?? entry.level;
            const svcPad     = entry.service.padEnd(11);

            return (
              <Box key={entry.id} flexDirection="row">
                <Text color="gray" dimColor>{entry.timestamp}</Text>
                <Text color="gray" dimColor>{'  '}</Text>
                <Text color={levelColor} bold>{`[${label}]`}</Text>
                <Text color="gray" dimColor>{'  '}</Text>
                <Text color="gray">{svcPad}</Text>
                <Text color="gray" dimColor>{'  '}</Text>
                <Text color="white">{entry.message}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
};
