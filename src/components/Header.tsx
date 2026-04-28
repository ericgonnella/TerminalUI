import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  title:    string;
  subtitle: string;
}

const SPIN_CHARS = ['|', '/', '-', '\\'];

/**
 * Top-of-screen header. Uses a slow (800 ms) custom tick instead of
 * `ink-spinner` because that library re-renders every ~80 ms — at 12 full
 * Ink re-renders per second this is the dominant cause of visible flicker
 * when running pgmanager over SSH. A 1.25 Hz tick is more than enough to
 * convey "live" without thrashing the terminal.
 */
export const Header: React.FC<HeaderProps> = ({ title, subtitle }) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 800);
    return () => clearInterval(t);
  }, []);
  const spinChar = SPIN_CHARS[tick % SPIN_CHARS.length] ?? '|';
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1}>
      <Text bold color="cyan">{'⚡ '}</Text>
      <Text bold color="white">{title}</Text>
      <Text color="gray">{'  ─  '}</Text>
      <Text color="gray">{subtitle}</Text>
      <Text color="gray">{'    '}</Text>
      <Text color="green">{spinChar}</Text>
      <Text color="green" bold>{' LIVE'}</Text>
      <Text color="gray" dimColor>{'    [q] quit'}</Text>
    </Box>
  );
};

