import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface HeaderProps {
  title:    string;
  subtitle: string;
}

export const Header: React.FC<HeaderProps> = ({ title, subtitle }) => (
  <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1}>
    <Text bold color="cyan">
      {'⚡ '}
    </Text>
    <Text bold color="white">
      {title}
    </Text>
    <Text color="gray">
      {'  ─  '}
    </Text>
    <Text color="gray">
      {subtitle}
    </Text>
    <Text color="gray">
      {'    '}
    </Text>
    <Text color="green">
      <Spinner type="dots" />
    </Text>
    <Text color="green" bold>
      {' LIVE'}
    </Text>
    <Text color="gray" dimColor>
      {'    [q] quit'}
    </Text>
  </Box>
);
