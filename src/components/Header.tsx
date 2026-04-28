import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  title:    string;
  subtitle: string;
}

/**
 * Top-of-screen header. Intentionally has NO timer / animation.
 *
 * Earlier revisions used `ink-spinner` (~12 Hz) and then a custom 800 ms
 * tick (~1.25 Hz) to show a "LIVE" indicator. Both produced visible
 * flicker over SSH/VPS sessions because the header sits above every
 * screen, so each tick forced Ink to re-render and re-diff the whole
 * tree. A static green dot conveys the same "running" status without
 * pinning the app to a periodic redraw cycle.
 *
 * Wrapped in `React.memo` so it only re-renders when title/subtitle
 * change (which is never, currently — they're constants from `App.tsx`).
 */
export const Header: React.FC<HeaderProps> = React.memo(function Header({ title, subtitle }) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1}>
      <Text bold color="cyan">{'⚡ '}</Text>
      <Text bold color="white">{title}</Text>
      <Text color="gray">{'  ─  '}</Text>
      <Text color="gray">{subtitle}</Text>
      <Text color="gray">{'    '}</Text>
      <Text color="green">{'●'}</Text>
      <Text color="green" bold>{' LIVE'}</Text>
      <Text color="gray" dimColor>{'    [q] quit'}</Text>
    </Box>
  );
});

