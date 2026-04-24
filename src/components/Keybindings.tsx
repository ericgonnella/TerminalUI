import React from 'react';
import { Box, Text } from 'ink';

export interface KeyBinding {
  key:   string;
  label: string;
}

interface KeybindingsProps {
  bindings: KeyBinding[];
}

export const Keybindings: React.FC<KeybindingsProps> = ({ bindings }) => (
  <Box marginTop={0}>
    {bindings.map((b, i) => (
      <React.Fragment key={i}>
        {i > 0 && <Text color="gray" dimColor>{'  '}</Text>}
        <Text color="cyan" bold>{`[${b.key}]`}</Text>
        <Text color="gray">{` ${b.label}`}</Text>
      </React.Fragment>
    ))}
  </Box>
);
