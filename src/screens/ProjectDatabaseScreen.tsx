/**
 * ProjectDatabaseScreen.tsx
 *
 * Full project database provisioning wizard implementing the pgManager
 * Integration Spec (pgmanager_integration_spec.md).
 *
 * Wizard flow:
 *   1. db-name          — Enter database / project name
 *   2. user-name        — Enter dedicated app role
 *   3. backend-location — Where is the backend API hosted?
 *   4. access-mode      — Choose security / network profile
 *   5. allowed-ips      — IP/CIDR input (allowlist modes only)
 *   6. public-ip        — VPS public IP (external modes only)
 *   7. review           — Show full summary with warnings
 *   8. provisioning     — Create DB + role + permissions
 *   9. access-config    — Apply UFW + pg_hba.conf rules
 *  10. health-check     — Verify connectivity
 *  11. env-output       — Show framework .env templates
 *  12. done / error
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner   from 'ink-spinner';

import {
  validateAppIdentifier,
  generateAppPassword,
  buildRedactedAppDatabaseUrl,
  provisionAppDatabase,
  type ProvisionAppResult,
} from '../services/appProvision';

import {
  ACCESS_MODE_INFO,
  BACKEND_LOCATION_LABELS,
  buildConnectionStrings,
  redactConnectionStrings,
  buildHbaRules,
  buildPermissionSql,
  renderEnvTemplate,
  detectUfwStatus,
  applyAccessMode,
  runHealthChecks,
  buildBackupCommands,
  buildExternalTestCommands,
  type ApplyAccessModeResult,
} from '../services/projectDatabase';

import { validateCidr } from '../services/remoteAccess';
import { Keybindings }  from '../components/Keybindings';
import type { Navigation }      from '../hooks/useNavigation';
import type { InstancesState }  from '../hooks/useInstances';
import type {
  Instance,
  AccessMode,
  BackendLocation,
  EnvTarget,
  ProjectHealthCheck,
} from '../types';
import { mutedColor } from '../theme';

// ─── Types ────────────────────────────────────────────────────────────────────

type WizardStep =
  | 'db-name'
  | 'user-name'
  | 'backend-location'
  | 'access-mode'
  | 'allowed-ips'
  | 'public-ip'
  | 'review'
  | 'provisioning'
  | 'access-config'
  | 'health-check'
  | 'env-output'
  | 'done'
  | 'error';

const ALL_ACCESS_MODES: AccessMode[] = [
  'internal',
  'testing_open',
  'testing_allowlist',
  'production_local',
  'production_allowlist',
  'production_vpn',
];

const ALL_BACKEND_LOCATIONS: BackendLocation[] = [
  'same_vps',
  'same_vps_docker',
  'external_vps',
  'netlify_functions',
  'vercel_functions',
  'local_dev_machine',
  'unknown',
];

const ALL_ENV_TARGETS: { key: EnvTarget; label: string }[] = [
  { key: 'node_express',    label: 'Node / Express' },
  { key: 'prisma',          label: 'Prisma' },
  { key: 'drizzle',         label: 'Drizzle ORM' },
  { key: 'netlify_frontend', label: 'Netlify Frontend (.env warning)' },
  { key: 'external_vps',   label: 'External VPS backend' },
];

// ─── Props ────────────────────────────────────────────────────────────────────

interface ProjectDatabaseScreenProps {
  nav:       Navigation;
  instances: InstancesState;
  instance:  Instance;
  pgCtlBin:  string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const ProjectDatabaseScreen: React.FC<ProjectDatabaseScreenProps> = ({
  nav, instances, instance: initialInstance, pgCtlBin,
}) => {
  const [instance] = useState<Instance>(initialInstance);

  // ── Wizard state ──────────────────────────────────────────────────────────
  const defaultDb   = instance.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z_]/, '_');
  const defaultUser = `${defaultDb || 'app'}_app`;

  const [step,            setStep]            = useState<WizardStep>('db-name');
  const [appDb,           setAppDb]           = useState(defaultDb);
  const [appUser,         setAppUser]         = useState(defaultUser);
  const [backendLocation, setBackendLocation] = useState<BackendLocation>('same_vps');
  const [accessMode,      setAccessMode]      = useState<AccessMode>('production_local');
  const [allowedIps,      setAllowedIps]      = useState<string[]>([]);
  const [ipInput,         setIpInput]         = useState('');
  const [publicIp,        setPublicIp]        = useState('');
  const [useTls,          setUseTls]          = useState(false);

  // Menu cursors
  const [backendCursor, setBackendCursor] = useState(0);
  const [modeCursor,    setModeCursor]    = useState(3); // default: production_local

  // Env template selection
  const [envCursor, setEnvCursor] = useState(0);

  // Results / errors
  const [provisionResult,  setProvisionResult]  = useState<ProvisionAppResult | null>(null);
  const [accessResult,     setAccessResult]     = useState<ApplyAccessModeResult | null>(null);
  const [healthResult,     setHealthResult]     = useState<ProjectHealthCheck | null>(null);
  const [fieldError,       setFieldError]       = useState<string | null>(null);
  const [errorMsg,         setErrorMsg]         = useState<string | null>(null);
  const [statusLines,      setStatusLines]      = useState<string[]>([]);
  const [revealUrl,        setRevealUrl]        = useState(false);

  const poppedRef = useRef(false);

  // ── Step helpers ──────────────────────────────────────────────────────────

  const needsAllowedIps = (m: AccessMode) =>
    m === 'testing_allowlist' || m === 'production_allowlist';

  const needsPublicIp = (m: AccessMode) =>
    ACCESS_MODE_INFO[m].requiresPublicIp;

  // ── Submit: database name ─────────────────────────────────────────────────
  const onDbSubmit = useCallback((v: string) => {
    const c = validateAppIdentifier(v, 'Database name');
    if (!c.ok) { setFieldError(c.reason); return; }
    const trimmed = v.trim();
    setAppDb(trimmed);
    setFieldError(null);
    if (appUser === defaultUser) setAppUser(`${trimmed}_app`);
    setStep('user-name');
  }, [appUser, defaultUser]);

  // ── Submit: role name ─────────────────────────────────────────────────────
  const onUserSubmit = useCallback((v: string) => {
    const c = validateAppIdentifier(v, 'Role name');
    if (!c.ok) { setFieldError(c.reason); return; }
    if (v.trim() === instance.superuser) {
      setFieldError(`Refuse to use superuser "${instance.superuser}". Pick a dedicated role.`);
      return;
    }
    setAppUser(v.trim());
    setFieldError(null);
    setStep('backend-location');
  }, [instance.superuser]);

  // ── Submit: IP input for allowlist ────────────────────────────────────────
  const onIpSubmit = useCallback((v: string) => {
    const trimmed = v.trim();
    if (!trimmed) {
      if (allowedIps.length === 0) {
        setFieldError('Add at least one IP or CIDR before continuing.');
        return;
      }
      setFieldError(null);
      setIpInput('');
      if (needsPublicIp(accessMode)) {
        setStep('public-ip');
      } else {
        setStep('review');
      }
      return;
    }

    const r = validateCidr(trimmed);
    if (!r.ok) {
      setFieldError(r.reason ?? 'Invalid IP or CIDR.');
      return;
    }
    if (r.value && !allowedIps.includes(r.value)) {
      setAllowedIps(prev => [...prev, r.value!]);
    }
    setIpInput('');
    setFieldError(null);
  }, [accessMode, allowedIps]);

  // ── Submit: public IP ─────────────────────────────────────────────────────
  const onPublicIpSubmit = useCallback((v: string) => {
    const trimmed = v.trim();
    if (!trimmed) {
      setFieldError('Public IP is required for external access modes.');
      return;
    }
    // Basic sanity check — not a full IPv4 validator, pg will validate at connect time.
    if (/[\s;|&`$<>@\\?#]/.test(trimmed)) {
      setFieldError('IP address contains invalid characters.');
      return;
    }
    setPublicIp(trimmed);
    setFieldError(null);
    setStep('review');
  }, []);

  // ── Provisioning ──────────────────────────────────────────────────────────
  const doProvision = useCallback(async () => {
    setStep('provisioning');
    setStatusLines([]);
    setErrorMsg(null);
    try {
      const res = await provisionAppDatabase(instance, { appDb, appUser });
      setProvisionResult(res);
      setStep('access-config');
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  }, [instance, appDb, appUser]);

  // ── Access mode configuration ─────────────────────────────────────────────
  const doApplyAccess = useCallback(async () => {
    setStatusLines(['Applying access mode configuration...']);
    try {
      const result = await applyAccessMode({
        instance,
        appDb,
        appUser,
        mode:     accessMode,
        cidrs:    allowedIps,
        useTls,
        pgCtlBin,
      });
      setAccessResult(result);
      setStatusLines(result.messages);
      setStep('health-check');
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  }, [instance, appDb, appUser, accessMode, allowedIps, useTls, pgCtlBin]);

  // Auto-start access config when step enters
  useEffect(() => {
    if (step === 'access-config') {
      void doApplyAccess();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Health checks ─────────────────────────────────────────────────────────
  const doHealthCheck = useCallback(async () => {
    setStatusLines(['Running health checks...']);
    try {
      const result = await runHealthChecks({ instance, appUser, appDb, pgCtlBin });
      setHealthResult(result);
      setStatusLines(result.details);
      setStep('env-output');
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  }, [instance, appUser, appDb, pgCtlBin]);

  // ── Key handling ──────────────────────────────────────────────────────────
  useInput((input, key) => {
    // Text input steps handle Escape to go back.
    if (step === 'db-name' || step === 'user-name' || step === 'allowed-ips' || step === 'public-ip') {
      if (key.escape) {
        if (poppedRef.current) return;
        poppedRef.current = true;
        nav.pop();
      }
      return;
    }

    // Backend location menu
    if (step === 'backend-location') {
      if (key.upArrow)   { setBackendCursor(c => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setBackendCursor(c => Math.min(ALL_BACKEND_LOCATIONS.length - 1, c + 1)); return; }
      if (key.return) {
        const loc = ALL_BACKEND_LOCATIONS[backendCursor];
        setBackendLocation(loc);
        setStep('access-mode');
        return;
      }
      if (key.escape) { if (!poppedRef.current) { poppedRef.current = true; nav.pop(); } return; }
      return;
    }

    // Access mode menu
    if (step === 'access-mode') {
      if (key.upArrow)   { setModeCursor(c => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setModeCursor(c => Math.min(ALL_ACCESS_MODES.length - 1, c + 1)); return; }
      if (input === 't' || input === 'T') { setUseTls(v => !v); return; }
      if (key.return) {
        const mode = ALL_ACCESS_MODES[modeCursor];
        setAccessMode(mode);
        if (needsAllowedIps(mode)) {
          setStep('allowed-ips');
        } else if (needsPublicIp(mode)) {
          setStep('public-ip');
        } else {
          setStep('review');
        }
        return;
      }
      if (key.escape) { setStep('backend-location'); return; }
      return;
    }

    // Review step
    if (step === 'review') {
      if (input === 'y' || input === 'Y' || key.return) {
        void doProvision();
        return;
      }
      if (input === 'b' || input === 'B') { setStep('access-mode'); return; }
      if (key.escape) { if (!poppedRef.current) { poppedRef.current = true; nav.pop(); } return; }
      return;
    }

    // Health check gate
    if (step === 'health-check') {
      if (accessResult && (input === 'r' || input === 'R' || key.return)) {
        void doHealthCheck();
        return;
      }
      if (key.escape) { setStep('env-output'); return; }
      return;
    }

    // Env output
    if (step === 'env-output') {
      if (key.upArrow)   { setEnvCursor(c => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setEnvCursor(c => Math.min(ALL_ENV_TARGETS.length - 1, c + 1)); return; }
      if (input === 'v' || input === 'V') { setRevealUrl(r => !r); return; }
      if (key.return || input === 'd' || input === 'D') { setStep('done'); return; }
      if (key.escape) { if (!poppedRef.current) { poppedRef.current = true; nav.pop(); } return; }
      return;
    }

    // Done / error
    if (step === 'done' || step === 'error') {
      if (key.escape || key.return || input === 'q' || input === 'Q') {
        if (!poppedRef.current) { poppedRef.current = true; nav.pop(); }
      }
      return;
    }
  });

  // ── Connection strings (for review/output) ────────────────────────────────
  const demoPassword = provisionResult?.password ?? '(generated at provisioning)';
  const cs = buildConnectionStrings(
    instance,
    appUser,
    demoPassword,
    appDb,
    accessMode,
    backendLocation,
    publicIp || undefined,
    useTls,
  );
  const redacted = redactConnectionStrings(cs);

  const selectedEnvTarget = ALL_ENV_TARGETS[envCursor].key;
  const envText = renderEnvTemplate(cs, selectedEnvTarget, 3100, 'https://your-site.netlify.app');

  // ── Warnings ──────────────────────────────────────────────────────────────
  const modeInfo     = ACCESS_MODE_INFO[accessMode];
  const activeWarnings = accessResult?.warnings ?? [];

  // ── Status icon helpers ───────────────────────────────────────────────────
  const statusIcon = (s: string | undefined) => {
    if (s === 'passed')  return <Text color="green">{'✓'}</Text>;
    if (s === 'failed')  return <Text color="red">{'✗'}</Text>;
    if (s === 'warning') return <Text color="yellow">{'⚠'}</Text>;
    return <Text color={mutedColor}>{'–'}</Text>;
  };

  // ──────────────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">

      {/* ── Persistent header ─────────────────────────────────────────────── */}
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
        <Text bold color="cyan">{'Project Database Provisioning'}</Text>
        <Text color={mutedColor}>
          {'Create a project-ready PostgreSQL database with access control and health checks.'}
        </Text>
        <Box marginTop={1}>
          <Box marginRight={3}><Text color={mutedColor}>{'Instance: '}</Text><Text color="white" bold>{instance.name}</Text></Box>
          <Box marginRight={3}><Text color={mutedColor}>{'Port: '}</Text><Text color="white">{String(instance.port)}</Text></Box>
          {appDb  && <Box marginRight={3}><Text color={mutedColor}>{'DB: '}</Text><Text color="cyan">{appDb}</Text></Box>}
          {appUser && <Box><Text color={mutedColor}>{'User: '}</Text><Text color="cyan">{appUser}</Text></Box>}
        </Box>
      </Box>

      {/* ── Step 1: Database name ─────────────────────────────────────────── */}
      {step === 'db-name' && (
        <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'Step 1 of 7 — Application database name'}</Text>
          <Text color={mutedColor}>{'Lowercase letters, digits, underscore only. Max 63 chars.'}</Text>
          <Box marginTop={1}>
            <Text>{'> '}</Text>
            <TextInput value={appDb} onChange={setAppDb} onSubmit={onDbSubmit} placeholder="weighttracker" />
          </Box>
          {fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
          <Box marginTop={1}><Text color={mutedColor}>{'Enter to continue   Esc to cancel'}</Text></Box>
        </Box>
      )}

      {/* ── Step 2: App role name ─────────────────────────────────────────── */}
      {step === 'user-name' && (
        <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'Step 2 of 7 — App role (login user)'}</Text>
          <Text color={mutedColor}>{`Non-superuser login role. Must NOT be "${instance.superuser}".`}</Text>
          <Box marginTop={1}>
            <Text>{'> '}</Text>
            <TextInput
              value={appUser}
              onChange={setAppUser}
              onSubmit={onUserSubmit}
              placeholder={`${appDb || 'app'}_app`}
            />
          </Box>
          {fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
          <Box marginTop={1}><Text color={mutedColor}>{'Enter to continue   Esc to cancel'}</Text></Box>
        </Box>
      )}

      {/* ── Step 3: Backend location ──────────────────────────────────────── */}
      {step === 'backend-location' && (
        <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'Step 3 of 7 — Where is your backend API hosted?'}</Text>
          <Text color={mutedColor}>{'This determines which host goes into your DATABASE_URL.'}</Text>
          <Box marginTop={1} flexDirection="column">
            {ALL_BACKEND_LOCATIONS.map((loc, i) => (
              <Box key={loc}>
                <Text color={i === backendCursor ? 'cyan' : mutedColor}>
                  {i === backendCursor ? '▶ ' : '  '}
                </Text>
                <Text color={i === backendCursor ? 'white' : mutedColor} bold={i === backendCursor}>
                  {BACKEND_LOCATION_LABELS[loc]}
                </Text>
              </Box>
            ))}
          </Box>
          {(backendLocation === 'netlify_functions' || backendLocation === 'vercel_functions') && (
            <Box marginTop={1}>
              <Text color="yellow">
                {'⚠ Serverless functions cannot connect to a loopback-only DB — choose an allowlist mode next.'}
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Keybindings bindings={[
              { key: '↑↓', label: 'navigate' },
              { key: 'Enter', label: 'select' },
              { key: 'Esc', label: 'back' },
            ]} />
          </Box>
        </Box>
      )}

      {/* ── Step 4: Access mode ───────────────────────────────────────────── */}
      {step === 'access-mode' && (
        <Box borderStyle="round" borderColor="blue" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'Step 4 of 7 — Choose access mode'}</Text>
          <Text color={mutedColor}>{'Controls which firewall and pg_hba.conf rules are applied.'}</Text>
          <Box marginTop={1} flexDirection="column">
            {ALL_ACCESS_MODES.map((mode, i) => {
              const info = ACCESS_MODE_INFO[mode];
              const selected = i === modeCursor;
              const secColor = info.securityLevel === 'very_high' || info.securityLevel === 'high'
                ? 'green'
                : info.securityLevel === 'medium_high' || info.securityLevel === 'medium'
                  ? 'yellow'
                  : 'red';
              return (
                <Box key={mode} flexDirection="column" marginBottom={selected ? 1 : 0}>
                  <Box>
                    <Text color={selected ? 'cyan' : mutedColor}>{selected ? '▶ ' : '  '}</Text>
                    <Text color={selected ? 'white' : mutedColor} bold={selected}>{info.label}</Text>
                    <Text color={secColor}>{`  [${info.securityLevel.replace('_', ' ')}]`}</Text>
                    {info.isTemporary && <Text color="yellow">{'  TEMPORARY'}</Text>}
                  </Box>
                  {selected && (
                    <Box marginLeft={3}>
                      <Text color={mutedColor}>{info.description}</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={mutedColor}>{'TLS (sslmode=require): '}</Text>
              <Text color={useTls ? 'green' : mutedColor}>{useTls ? 'enabled [T]' : 'disabled [T] to enable'}</Text>
            </Box>
          </Box>

          {ALL_ACCESS_MODES[modeCursor] === 'testing_open' && (
            <Box marginTop={1} borderStyle="classic" borderColor="red" paddingX={2}>
              <Text color="red" bold>
                {'⚠ TESTING OPEN: Exposes PostgreSQL to the entire internet.'}
              </Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Keybindings bindings={[
              { key: '↑↓', label: 'navigate' },
              { key: 'T', label: 'toggle TLS' },
              { key: 'Enter', label: 'select' },
              { key: 'Esc', label: 'back' },
            ]} />
          </Box>
        </Box>
      )}

      {/* ── Step 5: Allowed IPs (allowlist modes) ─────────────────────────── */}
      {step === 'allowed-ips' && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'Step 5 of 7 — IP / CIDR allowlist'}</Text>
          <Text color={mutedColor}>{'Add each IP or CIDR that should be allowed to connect.'}</Text>
          <Text color={mutedColor}>{'Enter a blank line when done.'}</Text>

          <Box marginTop={1} flexDirection="column">
            {allowedIps.map((ip, i) => (
              <Box key={i}>
                <Text color="green">{'  ✓ '}</Text>
                <Text color="cyan">{ip}</Text>
              </Box>
            ))}
            {allowedIps.length === 0 && (
              <Text color={mutedColor}>{'  (no IPs added yet)'}</Text>
            )}
          </Box>

          <Box marginTop={1}>
            <Text>{'> '}</Text>
            <TextInput
              value={ipInput}
              onChange={setIpInput}
              onSubmit={onIpSubmit}
              placeholder="203.0.113.5  or  10.0.0.0/24"
            />
          </Box>
          {fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
          <Box marginTop={1}>
            <Text color={mutedColor}>{'IP or CIDR, Enter to add.   Empty Enter when done.   Esc cancel'}</Text>
          </Box>
        </Box>
      )}

      {/* ── Step 6: Public IP (external modes) ───────────────────────────── */}
      {step === 'public-ip' && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="white" bold>{'Step 6 of 7 — VPS public IP'}</Text>
          <Text color={mutedColor}>
            {'Enter the public IP address of this VPS. Used to build the external DATABASE_URL.'}
          </Text>
          <Box marginTop={1}>
            <Text>{'> '}</Text>
            <TextInput
              value={publicIp}
              onChange={setPublicIp}
              onSubmit={onPublicIpSubmit}
              placeholder="203.0.113.1"
            />
          </Box>
          {fieldError && <Text color="red">{`  ✗ ${fieldError}`}</Text>}
          <Box marginTop={1}><Text color={mutedColor}>{'Enter to continue   Esc cancel'}</Text></Box>
        </Box>
      )}

      {/* ── Step 7: Review ───────────────────────────────────────────────── */}
      {step === 'review' && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="yellow" bold>{'Step 7 of 7 — Review & Execute'}</Text>
            <Text color={mutedColor}>{'─'.repeat(60)}</Text>

            {/* Core details */}
            <Box marginTop={1} flexDirection="column">
              <Box>
                <Text color={mutedColor}>{'Database:    '}</Text>
                <Text color="cyan" bold>{appDb}</Text>
              </Box>
              <Box>
                <Text color={mutedColor}>{'App role:    '}</Text>
                <Text color="cyan" bold>{appUser}</Text>
              </Box>
              <Box>
                <Text color={mutedColor}>{'Password:    '}</Text>
                <Text color="white">{'auto-generated 48-char hex (vault stored)'}</Text>
              </Box>
              <Box>
                <Text color={mutedColor}>{'Backend:     '}</Text>
                <Text color="white">{BACKEND_LOCATION_LABELS[backendLocation]}</Text>
              </Box>
              <Box>
                <Text color={mutedColor}>{'Access mode: '}</Text>
                <Text color={modeInfo.isTemporary ? 'yellow' : 'white'} bold>
                  {modeInfo.label}
                </Text>
              </Box>
              {allowedIps.length > 0 && (
                <Box>
                  <Text color={mutedColor}>{'Allowed IPs: '}</Text>
                  <Text color="cyan">{allowedIps.join(', ')}</Text>
                </Box>
              )}
              {useTls && (
                <Box>
                  <Text color={mutedColor}>{'TLS:         '}</Text>
                  <Text color="green">{'sslmode=require'}</Text>
                </Box>
              )}
            </Box>

            {/* Planned changes */}
            <Box marginTop={1} flexDirection="column">
              <Text color="white" bold>{'Planned changes:'}</Text>
              <Text color={mutedColor}>{'  • Create database: '}<Text color="cyan">{appDb}</Text></Text>
              <Text color={mutedColor}>{'  • Create role: '}<Text color="cyan">{appUser}</Text></Text>
              <Text color={mutedColor}>{'  • Grant CONNECT + read/write on '}<Text color="cyan">{appDb}</Text></Text>
              {(accessMode === 'testing_open') && (
                <Text color="red">{'  • UFW: open port '}<Text color="white">{String(instance.port)}</Text><Text color="red">{'/tcp to 0.0.0.0/0'}</Text></Text>
              )}
              {(accessMode === 'testing_allowlist' || accessMode === 'production_allowlist') && allowedIps.map(ip => (
                <Text key={ip} color="yellow">
                  {'  • UFW: allow from '}<Text color="cyan">{ip}</Text><Text color="yellow">{` port ${instance.port}/tcp`}</Text>
                </Text>
              ))}
              {(accessMode === 'internal' || accessMode === 'production_local' || accessMode === 'production_vpn') && (
                <Text color="green">{'  • UFW: port '}<Text color="white">{String(instance.port)}</Text><Text color="green">{'/tcp stays closed (public port not opened)'}</Text></Text>
              )}
              {buildHbaRules(appDb, appUser, accessMode, allowedIps, useTls).length > 0 && (
                <Text color={mutedColor}>{'  • pg_hba.conf: add managed access block'}</Text>
              )}
              {buildHbaRules(appDb, appUser, accessMode, allowedIps, useTls).length === 0 && (
                <Text color={mutedColor}>{'  • pg_hba.conf: no external rules needed (loopback mode)'}</Text>
              )}
            </Box>

            {/* Connection strings preview */}
            <Box marginTop={1} flexDirection="column">
              <Text color="white" bold>{'Connection strings (password will be real value):'}</Text>
              <Text color={mutedColor}>{'  Internal:    '}<Text color="green">{redacted.internal}</Text></Text>
              {redacted.external && (
                <Text color={mutedColor}>{'  External:    '}<Text color="cyan">{redacted.external}</Text></Text>
              )}
              <Text color="green">{'  Recommended: '}<Text color="white" bold>{redacted.recommended}</Text></Text>
            </Box>

            {/* Warnings */}
            {modeInfo.warnPublic && (
              <Box marginTop={1} borderStyle="classic" borderColor="red" paddingX={1}>
                <Text color="red" bold>
                  {'⚠ PUBLIC EXPOSURE: PostgreSQL will be accessible from the entire internet.'}
                </Text>
              </Box>
            )}
          </Box>

          <Box paddingX={2} marginBottom={1}>
            <Text color="green" bold>{'[Y/Enter]'}</Text>
            <Text color={mutedColor}>{' provision   '}</Text>
            <Text color="yellow" bold>{'[B]'}</Text>
            <Text color={mutedColor}>{' back to access mode   '}</Text>
            <Text color={mutedColor}>{'Esc cancel'}</Text>
          </Box>
        </Box>
      )}

      {/* ── Provisioning spinner ─────────────────────────────────────────── */}
      {step === 'provisioning' && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
          <Box>
            <Text color="yellow"><Spinner type="dots" /></Text>
            <Text color="yellow">{'  Creating database and role...'}</Text>
          </Box>
          <Text color={mutedColor}>{'PostgreSQL DDL is running. This should be fast.'}</Text>
        </Box>
      )}

      {/* ── Access config spinner ─────────────────────────────────────────── */}
      {step === 'access-config' && statusLines.length === 0 && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
          <Box>
            <Text color="yellow"><Spinner type="dots" /></Text>
            <Text color="yellow">{'  Configuring access mode...'}</Text>
          </Box>
        </Box>
      )}
      {step === 'access-config' && statusLines.length > 0 && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="yellow" bold>{'Applying access mode...'}</Text>
          {statusLines.map((l, i) => <Text key={i} color={mutedColor}>{`  ${l}`}</Text>)}
        </Box>
      )}

      {/* ── Health check gate ─────────────────────────────────────────────── */}
      {step === 'health-check' && !healthResult && accessResult && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="green" bold>{'✓ Access mode applied'}</Text>
            {accessResult.messages.map((l, i) => (
              <Text key={i} color={l.startsWith('ACTION') ? 'yellow' : mutedColor}>{`  ${l}`}</Text>
            ))}

            {accessResult.restartRequired && (
              <Box marginTop={1}>
                <Text color="yellow" bold>
                  {'ACTION REQUIRED: Restart PostgreSQL for listen_addresses change to take effect.'}
                </Text>
              </Box>
            )}

            {accessResult.rollbackCmds.length > 0 && (
              <Box marginTop={1} flexDirection="column">
                <Text color={mutedColor} bold>{'Rollback commands:'}</Text>
                {accessResult.rollbackCmds.map((cmd, i) => (
                  <Text key={i} color={mutedColor}>{`  ${cmd}`}</Text>
                ))}
              </Box>
            )}

            {accessResult.warnings.length > 0 && (
              <Box marginTop={1} flexDirection="column">
                {accessResult.warnings.map((w, i) => (
                  <Text key={i} color={w.level === 'error' ? 'red' : 'yellow'}>
                    {`  ${w.level === 'error' ? '✗' : '⚠'} ${w.message}`}
                  </Text>
                ))}
              </Box>
            )}
          </Box>

          <Box paddingX={2} marginBottom={1}>
            <Text color="cyan" bold>{'[R/Enter]'}</Text>
            <Text color={mutedColor}>{' run health checks   '}</Text>
            <Text color={mutedColor}>{'Esc skip to env output'}</Text>
          </Box>
        </Box>
      )}

      {/* Health check running */}
      {step === 'health-check' && !healthResult && !accessResult && (
        <Box>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text color="yellow">{'  Running health checks...'}</Text>
        </Box>
      )}

      {/* ── Env output ───────────────────────────────────────────────────── */}
      {step === 'env-output' && provisionResult && (
        <Box flexDirection="column">

          {/* Health results summary */}
          {healthResult && (
            <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} marginBottom={1}>
              <Text color="cyan" bold>{'Health check results'}</Text>
              <Box flexDirection="column" marginTop={1}>
                <Box>
                  {statusIcon(healthResult.pgIsReady)}
                  <Text color={mutedColor}>{' pg_isready'}</Text>
                </Box>
                <Box>
                  {statusIcon(healthResult.localSql)}
                  <Text color={mutedColor}>{' local SQL connection'}</Text>
                </Box>
                <Box>
                  {statusIcon(healthResult.listener)}
                  <Text color={mutedColor}>{' listener (ss check)'}</Text>
                </Box>
                <Box>
                  {statusIcon(healthResult.firewallCheck)}
                  <Text color={mutedColor}>{' firewall status'}</Text>
                </Box>
              </Box>
              {healthResult.details.map((d, i) => (
                <Text key={i} color={mutedColor}>{`  ${d}`}</Text>
              ))}
            </Box>
          )}

          {/* Warnings */}
          {activeWarnings.length > 0 && (
            <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={2} marginBottom={1}>
              <Text color="red" bold>{'Warnings'}</Text>
              {activeWarnings.map((w, i) => (
                <Text key={i} color={w.level === 'error' ? 'red' : 'yellow'}>
                  {`  ${w.level === 'error' ? '✗' : '⚠'} [${w.code}] ${w.message}`}
                </Text>
              ))}
            </Box>
          )}

          {/* Framework .env selector */}
          <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
            <Text color="green" bold>{'Environment template'}</Text>
            <Box marginTop={1} flexDirection="column">
              {ALL_ENV_TARGETS.map((t, i) => (
                <Box key={t.key}>
                  <Text color={i === envCursor ? 'cyan' : mutedColor}>
                    {i === envCursor ? '▶ ' : '  '}
                  </Text>
                  <Text color={i === envCursor ? 'white' : mutedColor} bold={i === envCursor}>
                    {t.label}
                  </Text>
                </Box>
              ))}
            </Box>

            <Box marginTop={1} borderStyle="classic" borderColor={mutedColor} paddingX={1} flexDirection="column">
              <Text color={mutedColor} bold>{'Generated .env template:'}</Text>
              {(revealUrl ? envText : envText.replace(/:([^:@/\s]+)@/g, ':****@'))
                .split('\n')
                .map((line, i) => (
                  <Text key={i} color={
                    line.startsWith('#') ? mutedColor : line.includes('DATABASE_URL') ? 'green' : 'white'
                  }>
                    {line}
                  </Text>
                ))}
            </Box>

            <Box marginTop={1} flexDirection="column">
              <Text color="white" bold>{'Recommended DATABASE_URL:'}</Text>
              <Text color={revealUrl ? 'red' : 'green'}>
                {revealUrl ? cs.recommended : redacted.recommended}
              </Text>
              {revealUrl && (
                <Text color="red">{'  ⚠ Password visible — press [V] to hide'}</Text>
              )}
            </Box>

            {/* Docker hints */}
            {cs.dockerHints.length > 0 && (
              <Box marginTop={1} flexDirection="column">
                <Text color="yellow" bold>{'Docker host hints (try in order if first fails):'}</Text>
                {cs.dockerHints.map((h, i) => (
                  <Text key={i} color={mutedColor}>{`  ${redactConnectionStrings({ ...cs, recommended: h }).recommended}`}</Text>
                ))}
              </Box>
            )}

            {/* External test commands */}
            {publicIp && (
              <Box marginTop={1} flexDirection="column">
                <Text color={mutedColor} bold>{'Client-side connectivity tests:'}</Text>
                {(() => {
                  const cmds = buildExternalTestCommands(publicIp, instance.port, appUser, appDb);
                  return (
                    <>
                      <Text color={mutedColor}>{'  PowerShell: '}<Text color="white">{cmds.powershell}</Text></Text>
                      <Text color={mutedColor}>{'  Linux/macOS: '}<Text color="white">{cmds.linux}</Text></Text>
                      <Text color={mutedColor}>{'  Docker test: '}<Text color="white">{cmds.docker}</Text></Text>
                    </>
                  );
                })()}
              </Box>
            )}

            {/* Backup commands */}
            <Box marginTop={1} flexDirection="column">
              <Text color={mutedColor} bold>{'Backup commands:'}</Text>
              {(() => {
                const b = buildBackupCommands(instance, appDb);
                return (
                  <>
                    <Text color={mutedColor}>{'  Quick: '}<Text color="white">{b.manual}</Text></Text>
                    <Text color={mutedColor}>{'  Compressed: '}<Text color="white">{b.compressed}</Text></Text>
                  </>
                );
              })()}
            </Box>
          </Box>

          <Box paddingX={2} marginBottom={1}>
            <Text color={mutedColor}>{'↑↓ select template   '}</Text>
            <Text color="cyan" bold>{'[V]'}</Text>
            <Text color={mutedColor}>{' reveal/hide password   '}</Text>
            <Text color="green" bold>{'[D/Enter]'}</Text>
            <Text color={mutedColor}>{' done   Esc back'}</Text>
          </Box>
        </Box>
      )}

      {/* ── Done ─────────────────────────────────────────────────────────── */}
      {step === 'done' && (
        <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="green" bold>{'✓ Project database provisioning complete'}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={mutedColor}>{'Database:     '}<Text color="cyan" bold>{appDb}</Text></Text>
            <Text color={mutedColor}>{'App role:     '}<Text color="cyan" bold>{appUser}</Text></Text>
            <Text color={mutedColor}>{'Access mode:  '}<Text color="white">{ACCESS_MODE_INFO[accessMode].label}</Text></Text>
            <Text color={mutedColor}>{'Recommended:  '}<Text color="green">{redacted.recommended}</Text></Text>
          </Box>
          <Box marginTop={1}>
            <Text color={mutedColor}>{'Press Esc / Enter / Q to return.'}</Text>
          </Box>
        </Box>
      )}

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {step === 'error' && (
        <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={2} marginBottom={1}>
          <Text color="red" bold>{'✗ Provisioning failed'}</Text>
          <Text color="red">{errorMsg ?? 'Unknown error.'}</Text>
          <Box marginTop={1}><Text color={mutedColor}>{'Press Esc / Enter to go back.'}</Text></Box>
        </Box>
      )}

    </Box>
  );
};
