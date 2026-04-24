import React from 'react';
import { Box, Text, useInput } from 'ink';

interface ConfirmDialogProps {
  message:   string;
  onConfirm: () => void;
  onCancel:  () => void;
  danger?:   boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  message,
  onConfirm,
  onCancel,
  danger = false,
}) => {
  useInput((input) => {
    if (input === 'y' || input === 'Y') onConfirm();
    if (input === 'n' || input === 'N') onCancel();
  });

  return (
    <Box borderStyle="round" borderColor={danger ? 'red' : 'yellow'} paddingX={2} marginY={1}>
      <Text color={danger ? 'red' : 'yellow'} bold>
        {danger ? '⚠  ' : '? '}
      </Text>
      <Text color="white">{message}</Text>
      <Text color="gray" dimColor>{'  '}</Text>
      <Text color="green" bold>{'[Y]'}</Text>
      <Text color="gray">{' yes  '}</Text>
      <Text color="red" bold>{'[N]'}</Text>
      <Text color="gray">{' no'}</Text>
    </Box>
  );
};
