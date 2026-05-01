import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner   from 'ink-spinner';
import { Keybindings }     from '../components/Keybindings';
import {
  provisionAppDatabase,
  saveBackendEnvFile,
  validateAppIdentifier,
  buildRedactedAppDatabaseUrl,
  type ProvisionAppResult,
} from '../services/appProvision';
import type { Navigation } from '../hooks/useNavigation';
import type { Instance }   from '../types';
import { mutedColor } from '../theme';

type Step = 'db-name' | 'user-name' | 'cors' | 'confirm' | 'running' | 'done' | 'error';

interface ProvisionAppScreenProps {
  nav:      Navigation;
  instance: Instance;
}

/**
 * UI driver for `provisionAppDatabase`. Implements the
 * "PGManager → Netlify App Integration" spec:
 *   1. Ask for app DB and app role names.
 *   2. Optionally ask for the Netlify origin so the generated `.env` has a
 *      pre-filled `CORS_ORIGIN`.
 *   3. Provision idempotently against the running instance.
 *   4. Display the resulting DATABASE_URL (redacted by default) and offer
 *      to save a `.env` file under ~/.pgmanager/env/.
 */
export const ProvisionAppScreen: React.FC<ProvisionAppScreenProps> = ({ nav, instance }) => {
  // Sensible defaults derived from the instance name.
  const defaultDb   = instance.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z_]/, '_');
  const defaultUser = `${defaultDb || 'app'}_app`;

  const [step,    setStep]    = useState<Step>('db-name');
  const [appDb,   setAppDb]   = useState(defaultDb);
  const [appUser, setAppUser] = useState(defaultUser);
  const [corsOrigin, setCorsOrigin] = useState('https://your-netlify-site.netlify.app');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const [result,  setResult]  = useState<ProvisionAppResult | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [reveal,  setReveal]  = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const poppedRef = useRef(false);

  // ── Submit handlers ────────────────────────────────────────────────────────
  const onDbSubmit = useCallback((v: string) => {
    const c = validateAppIdentifier(v, 'Database name');
    if (!c.ok) { setFieldError(c.reason); return; }
    setAppDb(v.trim());
    setFieldError(null);
    // Refresh default user name to track DB name unless the user already
    // edited it manually.
    if (appUser === defaultUser) setAppUser(`${v.trim()}_app`);
    setStep('user-name');
  }, [appUser, defaultUser]);

  const onUserSubmit = useCallback((v: string) => {
    const c = validateAppIdentifier(v, 'Role name');
    if (!c.ok) { setFieldError(c.reason); return; }
    if (v.trim() === instance.superuser) {
      setFieldError(`Refuse to use the superuser "${instance.superuser}". Pick a dedicated role.`);
      return;
    }
    setAppUser(v.trim());
    setFieldError(null);
    setStep('cors');
  }, [instance.superuser]);

  const onCorsSubmit = useCallback((v: string) => {
    const trimmed = v.trim();
    if (trimmed) setCorsOrigin(trimmed);
    setFieldError(null);
    setStep('confirm');
  }, []);

  const doProvision = useCallback(async () => {
    setStep('running');
    setError(null);
    try {
      const res = await provisionAppDatabase(instance, { appDb, appUser });
      setResult(res);
      setStep('done');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  }, [instance, appDb, appUser]);

  const doSaveEnv = useCallback(() => {
    if (!result) return;
    setSaveError(null);
    try {
      const file = saveBackendEnvFile(instance, result, { corsOrigin });
      setSavedPath(file);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }, [instance, result, corsOrigin]);

  // ── Input routing ──────────────────────────────────────────────────────────
  useInput((input, key) => {
    // Text-input steps own the keyboard.
    if (step === 'db-name' || step === 'user-name' || step === 'cors') {
      if (key.escape) {
        if (poppedRef.current) return;
        poppedRef.current = true;
        nav.pop();
      }
      return;
    }
    if (step === 'confirm') {
      if (input === 'y' || input === 'Y' || key.return) { void doProvision(); return; }
      if (input === 'n' || input === 'N' || key.escape) {
        // Allow editing the names again
        setStep('db-name');
      }
      return;
    }
    if (step === 'done') {
      if (input === 's' || input === 'S') { doSaveEnv(); return; }
      if (input === 'r' || input === 'R') { setReveal(r => !r); return; }
      if (key.escape || key.return || input === 'q' || input === 'Q') {
        if (poppedRef.current) return;
        poppedRef.current = true;
        nav.pop();
      }
      return;
    }
    if (step === 'error') {
      if (key.escape || key.return) {
        if (poppedRef.current) return;
        poppedRef.current = true;
        nav.pop();
      }
      return;
    }
  });

  // ── Network exposure warning ───────────────────────────────────────────────
  // The spec requires Postgres to bind to 127.0.0.1. If the instance is
  // hosted/non-loopback we surface a warning so the operator double-checks.
  const host = instance.host ?? '127.0.0.1';
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const showHostWarning = !isLoopback || instance.installationType === 'hosted';

  return (
    <Box flexDirection="column">
      {/* Header / context panel */}
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
        <Text bold color="cyan">{'Provision app database for VPS backend'}</Text>
        <Text color={mutedColor}>{'Generates a dedicated DB + role + DATABASE_URL for a Netlify-friendly stack.'}</Text>
        <Box marginTop={1}>
          <Text color={mutedColor}>{'Instance: '}</Text>
          <Text color="white" bold>{instance.name}</Text>
          <Text color={mutedColor}>{'   Host: '}</Text>
          <Text color={isLoopback ? 'green' : 'yellow'}>{host}</Text>
          <Text color={mutedColor}>{'   Port: '}</Text>
          <Text color="white">{String(instance.port)}</Text>
        </Box>
        {showHostWarning && (
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow" bold>{'⚠  Network exposure check'}</Text>
            <Text color="yellow">
              {'   Per the integration spec, PostgreSQL should bind to 127.0.0.1 only.'}
            </Text>
            <Text color="yellow">
              {'   The generated DATABASE_URL pins host=127.0.0.1 regardless, but make'}
            </Text>
            <Text color="yellow">
              {'   sure `ss -lntp | grep ' + String(instance.port) + '` shows 127.0.0.1 on the VPS.'}
            </Text>
          </Box>
        )}
      </Box>

      {/* Step 1: DB name */}
      {step === 'db-name' && (
        <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'Application database name'}</Text>
          <Text color={mutedColor}>{'Lowercase letters, digits, underscore. Max 63 chars.'}</Text>
          <Box marginTop={1}>
            <Text color="white">{'> '}</Text>
            <TextInput value={appDb} onChange={setAppDb} onSubmit={onDbSubmit} placeholder="tracker_test" />
          </Box>
          {!!fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
        </Box>
      )}

      {/* Step 2: Role name */}
      {step === 'user-name' && (
        <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'Application role (login user)'}</Text>
          <Text color={mutedColor}>{`A non-superuser, login-only role. Must NOT be "${instance.superuser}".`}</Text>
          <Box marginTop={1}>
            <Text color="white">{'> '}</Text>
            <TextInput value={appUser} onChange={setAppUser} onSubmit={onUserSubmit} placeholder={`${appDb || 'app'}_app`} />
          </Box>
          {!!fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
        </Box>
      )}

      {/* Step 3: CORS origin (optional but pre-filled) */}
      {step === 'cors' && (
        <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'Netlify origin for CORS_ORIGIN (optional)'}</Text>
          <Text color={mutedColor}>{'Used in the generated backend .env. Leave default if unsure — you can edit later.'}</Text>
          <Box marginTop={1}>
            <Text color="white">{'> '}</Text>
            <TextInput value={corsOrigin} onChange={setCorsOrigin} onSubmit={onCorsSubmit} placeholder="https://your-site.netlify.app" />
          </Box>
        </Box>
      )}

      {/* Step 4: Confirm */}
      {step === 'confirm' && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="yellow" bold>{'Ready to provision'}</Text>
          <Text color={mutedColor}>{'─'.repeat(56)}</Text>
          <Box flexDirection="column" marginTop={1}>
            <Box><Text color={mutedColor}>{'Database:    '}</Text><Text color="cyan" bold>{appDb}</Text></Box>
            <Box><Text color={mutedColor}>{'Role:        '}</Text><Text color="cyan" bold>{appUser}</Text></Box>
            <Box><Text color={mutedColor}>{'Owner:       '}</Text><Text color="white">{`role "${appUser}"`}</Text></Box>
            <Box><Text color={mutedColor}>{'Password:    '}</Text><Text color="white">{'48-char hex (auto-generated, stored in vault)'}</Text></Box>
            <Box><Text color={mutedColor}>{'CORS_ORIGIN: '}</Text><Text color="white">{corsOrigin}</Text></Box>
          </Box>
          <Box marginTop={1}>
            <Text color="green" bold>{'[Y]'}</Text><Text color={mutedColor}>{' provision   '}</Text>
            <Text color="red" bold>{'[N]'}</Text><Text color={mutedColor}>{' edit names   '}</Text>
            <Text color={mutedColor}>{'Esc cancel'}</Text>
          </Box>
        </Box>
      )}

      {step === 'running' && (
        <Box>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text color="yellow">{'  Provisioning...'}</Text>
        </Box>
      )}

      {step === 'error' && (
        <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="red" bold>{'✗ Provisioning failed'}</Text>
          <Text color="red">{error ?? 'Unknown error.'}</Text>
          <Box marginTop={1}><Text color={mutedColor}>{'Press Esc / Enter to go back.'}</Text></Box>
        </Box>
      )}

      {step === 'done' && result && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="green" bold>{'✓ App database provisioned'}</Text>
            <Text color={mutedColor}>{'─'.repeat(56)}</Text>
            <Box marginTop={1} flexDirection="column">
              <Box>
                <Text color={mutedColor}>{'Database:  '}</Text>
                <Text color="cyan" bold>{result.appDb}</Text>
                {result.databaseExisted && <Text color="yellow">{'  (already existed — preserved)'}</Text>}
              </Box>
              <Box>
                <Text color={mutedColor}>{'Role:      '}</Text>
                <Text color="cyan" bold>{result.appUser}</Text>
                {result.roleExisted && !result.passwordWritten && (
                  <Text color="yellow">{'  (existed; password kept)'}</Text>
                )}
                {result.roleExisted && result.passwordWritten && (
                  <Text color="yellow">{'  (existed; password rotated)'}</Text>
                )}
              </Box>
            </Box>

            <Box marginTop={1} flexDirection="column">
              <Text color="white" bold>{'DATABASE_URL'}</Text>
              <Text color={reveal ? 'red' : 'green'}>
                {reveal ? result.databaseUrl : buildRedactedAppDatabaseUrl(instance, result.appUser, result.appDb)}
              </Text>
              {reveal && (
                <Text color="red">{'  ⚠ Visible on screen — copy it now and press [R] to hide.'}</Text>
              )}
            </Box>

            <Box marginTop={1} flexDirection="column">
              <Text color={mutedColor}>{'For the VPS backend .env (NEVER expose to Netlify frontend):'}</Text>
              <Text color={mutedColor}>{`  DATABASE_URL=postgresql://${result.appUser}:****@127.0.0.1:${instance.port}/${result.appDb}`}</Text>
              <Text color={mutedColor}>{'  PORT=3100'}</Text>
              <Text color={mutedColor}>{`  CORS_ORIGIN=${corsOrigin}`}</Text>
            </Box>

            {savedPath && (
              <Box marginTop={1} flexDirection="column">
                <Text color="green">{'✓ Saved .env to:'}</Text>
                <Text color="white">{`  ${savedPath}`}</Text>
                <Text color={mutedColor}>{'  Mode 0600. Move this file to your VPS backend (do NOT commit).'}</Text>
              </Box>
            )}
            {saveError && (
              <Box marginTop={1}>
                <Text color="red">{`✗ Save failed: ${saveError}`}</Text>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* Keybindings strip */}
      {step === 'done' ? (
        <Keybindings bindings={[
          { key: 'S',   label: 'save .env'           },
          { key: 'R',   label: reveal ? 'hide URL' : 'reveal URL' },
          { key: 'Esc', label: 'back'                },
        ]} />
      ) : (
        <Keybindings bindings={[
          { key: 'Enter', label: 'submit' },
          { key: 'Esc',   label: 'cancel' },
        ]} />
      )}
    </Box>
  );
};
