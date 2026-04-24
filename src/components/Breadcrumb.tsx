import React from 'react';
import { Box, Text } from 'ink';
import type { ScreenDef } from '../types';

const LABELS: Record<ScreenDef['name'], string> = {
  'home':           'Home',
  'new-instance':   'New Instance',
  'instance':       'Instance',
  'databases':      'Databases',
  'users':          'Users',
  'migrations':     'Migrations',
  'table-browser':  'Table Browser',
  'query':          'Query Runner',
  'download-pg':    'Get PostgreSQL',
};

interface BreadcrumbProps {
  stack: ScreenDef[];
}

export const Breadcrumb: React.FC<BreadcrumbProps> = ({ stack }) => (
  <Box marginBottom={0}>
    {stack.map((s, i) => {
      let label = LABELS[s.name] ?? s.name;
      if (s.name === 'instance' || s.name === 'databases' ||
          s.name === 'users'    || s.name === 'migrations' ||
          s.name === 'table-browser' || s.name === 'query') {
        label = (s as { instance?: { name: string } }).instance?.name ?? label;
      }
      const isLast = i === stack.length - 1;
      return (
        <React.Fragment key={i}>
          <Text color={isLast ? 'cyan' : 'gray'} bold={isLast}>{label}</Text>
          {!isLast && <Text color="gray" dimColor>{' › '}</Text>}
        </React.Fragment>
      );
    })}
  </Box>
);
