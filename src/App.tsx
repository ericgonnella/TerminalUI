import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Header }     from './components/Header';
import { Breadcrumb } from './components/Breadcrumb';
import { useNavigation }  from './hooks/useNavigation';
import { useInstances }   from './hooks/useInstances';
import { HomeScreen }         from './screens/HomeScreen';
import { NewInstanceScreen }  from './screens/NewInstanceScreen';
import { ImportInstanceScreen } from './screens/ImportInstanceScreen';
import { InstanceScreen }     from './screens/InstanceScreen';
import { DatabasesScreen }    from './screens/DatabasesScreen';
import { UsersScreen }        from './screens/UsersScreen';
import { MigrationsScreen }   from './screens/MigrationsScreen';
import { TableBrowserScreen } from './screens/TableBrowserScreen';
import { QueryScreen }        from './screens/QueryScreen';
import { DownloadPgScreen }        from './screens/DownloadPgScreen';
import { DatabaseDetailScreen }    from './screens/DatabaseDetailScreen';
import { ProvisionAppScreen }      from './screens/ProvisionAppScreen';
import { RemoteAccessScreen }      from './screens/RemoteAccessScreen';
import { HostedSetupScreen }       from './screens/HostedSetupScreen';
import { CloudflareTunnelScreen }  from './screens/CloudflareTunnelScreen';
import { ProjectDatabaseScreen }   from './screens/ProjectDatabaseScreen';
import { detectPostgres }     from './services/pgDetect';

interface AppProps {
  pgCtlBin:  string;
  initdbBin: string;
}

export const App: React.FC<AppProps> = ({ pgCtlBin: initialPgCtl, initdbBin: initialInitdb }) => {
  const { exit }  = useApp();
  const nav       = useNavigation();
  const instances = useInstances();

  const [pgCtlBin,  setPgCtlBin]  = useState(initialPgCtl);
  const [initdbBin, setInitdbBin] = useState(initialInitdb);

  /** Re-detect binaries after a managed version is installed. */
  const handleVersionInstalled = useCallback(async (_major: number) => {
    const pg = await detectPostgres();
    if (pg) {
      setPgCtlBin(pg.pgCtl);
      setInitdbBin(pg.initdb);
    }
  }, []);

  // Global quit: q or Ctrl+C (individual screens suppress this when in text input mode)
  useInput((input, key) => {
    if ((input === 'q' || input === 'Q') && nav.screen.name === 'home') {
      exit();
    }
    if (key.ctrl && input === 'c') {
      exit();
    }
  });

  const screen = nav.screen;

  const renderScreen = () => {
    switch (screen.name) {
      case 'home':
        return (
          <HomeScreen
            nav={nav}
            instances={instances}
            pgCtlBin={pgCtlBin}
          />
        );
      case 'new-instance':
        return (
          <NewInstanceScreen
            nav={nav}
            instances={instances}
            pgCtlBin={pgCtlBin}
            initdbBin={initdbBin}
          />
        );
      case 'import-instance':
        return (
          <ImportInstanceScreen
            nav={nav}
            instances={instances}
          />
        );
      case 'instance':
        return (
          <InstanceScreen
            nav={nav}
            instances={instances}
            instance={screen.instance}
            pgCtlBin={pgCtlBin}
          />
        );
      case 'databases':
        return (
          <DatabasesScreen
            nav={nav}
            instance={screen.instance}
            database={screen.database}
          />
        );
      case 'users':
        return <UsersScreen nav={nav} instance={screen.instance} />;
      case 'migrations':
        return (
          <MigrationsScreen
            nav={nav}
            instance={screen.instance}
            database={screen.database}
          />
        );
      case 'table-browser':
        return (
          <TableBrowserScreen
            nav={nav}
            instance={screen.instance}
            database={screen.database}
          />
        );
      case 'query':
        return (
          <QueryScreen
            nav={nav}
            instance={screen.instance}
            database={screen.database}
          />
        );
      case 'download-pg':
        return <DownloadPgScreen nav={nav} onInstalled={handleVersionInstalled} />;
      case 'database-detail':
        return (
          <DatabaseDetailScreen
            nav={nav}
            instance={screen.instance}
            database={screen.database}
          />
        );
      case 'provision-app':
        return (
          <ProvisionAppScreen
            nav={nav}
            instance={screen.instance}
          />
        );
      case 'remote-access':
        return (
          <RemoteAccessScreen
            nav={nav}
            instances={instances}
            instance={screen.instance}
            pgCtlBin={pgCtlBin}
          />
        );
      case 'hosted-setup':
        return (
          <HostedSetupScreen
            nav={nav}
            instances={instances}
            instance={screen.instance}
          />
        );
      case 'cloudflare-tunnel':
        return (
          <CloudflareTunnelScreen
            nav={nav}
            instance={screen.instance}
          />
        );
      case 'project-database':
        return (
          <ProjectDatabaseScreen
            nav={nav}
            instances={instances}
            instance={screen.instance}
            pgCtlBin={pgCtlBin}
          />
        );
      default:
        return <Text color="red">{'Unknown screen'}</Text>;
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header title="PGMANAGER" subtitle="PostgreSQL Manager" />
      <Box marginBottom={1}>
        <Breadcrumb stack={nav.stack} />
      </Box>
      {renderScreen()}
    </Box>
  );
};

