import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

function formatUptime(start: Date): string {
  const sec = Math.floor((Date.now() - start.getTime()) / 1000);
  const h   = Math.floor(sec / 3600);
  const m   = Math.floor((sec % 3600) / 60);
  const s   = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function timeNow(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

interface StatusBarProps {
  startTime:     Date;
  totalEvents:   number;
  totalRequests: number;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  startTime,
  totalEvents,
  totalRequests,
}) => {
  const [now, setNow] = useState(timeNow);

  useEffect(() => {
    const t = setInterval(() => setNow(timeNow()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={2}>
      <Text color="green">{'● '}</Text>
      <Text color="green" bold>{'ONLINE'}</Text>
      <Text color="gray" dimColor>{'  │  Uptime: '}</Text>
      <Text color="white">{formatUptime(startTime)}</Text>
      <Text color="gray" dimColor>{'  │  Events: '}</Text>
      <Text color="cyan">{String(totalEvents)}</Text>
      <Text color="gray" dimColor>{'  │  Total Reqs: '}</Text>
      <Text color="cyan">{totalRequests.toLocaleString()}</Text>
      <Text color="gray" dimColor>{'  │  '}</Text>
      <Text color="white">{now}</Text>
    </Box>
  );
};
