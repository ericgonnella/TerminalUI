import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import {
  buildCloudflareTunnelForInstance,
  type BuiltTunnelScript,
} from '../services/hostedSetup';
import type { Navigation } from '../hooks/useNavigation';
import type { Instance } from '../types';

interface Props {
  nav:      Navigation;
  instance: Instance;
}

type Step = 'welcome' | 'hostname' | 'review' | 'client';

/**
 * Guided Cloudflare Tunnel setup.
 *
 * For VPSs whose cloud provider silently drops inbound packets on the
 * Postgres port (BuyVM/ColoCrossing AbuseGuard, restrictive AWS SGs you
 * can't change, etc.) — `cloudflared` reverses direction with a single
 * outbound HTTPS connection from the VPS to Cloudflare's edge.
 *
 * Limitations are stated up-front in the welcome step so the user
 * doesn't pick this for a use case it can't serve (Netlify functions).
 */
export const CloudflareTunnelScreen: React.FC<Props> = ({ nav, instance }) => {
  const [step, setStep] = useState<Step>('welcome');
  const [hostname, setHostname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<BuiltTunnelScript | null>(null);
  const poppedRef = useRef(false);

  const goBack = useCallback(() => {
    if (poppedRef.current) return;
    poppedRef.current = true;
    nav.pop();
  }, [nav]);

  const buildAndShow = useCallback((host: string) => {
    try {
      const b = buildCloudflareTunnelForInstance(instance, host);
      setBuilt(b);
      setError(null);
      setStep('review');
    } catch (err: any) {
      setError(String(err?.message ?? err));
    }
  }, [instance]);

  useInput((input, key) => {
    if (step === 'welcome') {
      if (key.return) { setStep('hostname'); return; }
      if (key.escape) { goBack(); return; }
      return;
    }
    if (step === 'hostname' && key.escape) { setStep('welcome'); return; }
    if (step === 'review') {
      if (key.return) { setStep('client'); return; }
      if (key.escape) { setStep('hostname'); return; }
      return;
    }
    if (step === 'client') {
      if (key.return || key.escape) { goBack(); return; }
      return;
    }
  });

  if (step === 'welcome') {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="magenta" paddingX={2} flexDirection="column">
          <Text color="magenta" bold>{'Cloudflare Tunnel — bypass upstream firewall'}</Text>
          <Text color="gray">{'─'.repeat(56)}</Text>
          <Text color="white">
            {'Use this when your cloud provider silently drops inbound traffic on'}
          </Text>
          <Text color="white">
            {`port ${instance.port} (e.g. BuyVM AbuseGuard, restrictive cloud security groups).`}
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">{'How it works:'}</Text>
            <Text color="white">{'  • cloudflared on the VPS makes a long-lived outbound HTTPS connection'}</Text>
            <Text color="white">{'  • Cloudflare brokers traffic from clients into the VPS — NO inbound port'}</Text>
            <Text color="white">{'  • You connect via a hostname like  pg.example.com'}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="green">{'Requirements:'}</Text>
            <Text color="white">{'  1. A domain you own added to Cloudflare (free plan is fine)'}</Text>
            <Text color="white">{'  2. The ability to run the install script as root on the VPS'}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow" bold>{'⚠  Limitation — Netlify / serverless front-ends'}</Text>
            <Text color="gray">{'   TCP-mode tunnels require the CLIENT to also run cloudflared, which'}</Text>
            <Text color="gray">{'   Netlify Functions cannot do. This wizard works for:'}</Text>
            <Text color="gray">{'     ✓ You connecting from a laptop / dev machine'}</Text>
            <Text color="gray">{'     ✓ A backend you control (long-running VM, Fly.io machine, etc.)'}</Text>
            <Text color="gray">{'     ✗ Netlify Functions, Vercel Edge — for those use a managed pooler'}</Text>
            <Text color="gray">{'       (Supabase pooler, Neon) or open the upstream firewall instead.'}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="green" bold>{'[Enter] '}</Text><Text color="white">{'continue   '}</Text>
            <Text color="gray" bold>{'[Esc] '}</Text><Text color="gray">{'cancel'}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (step === 'hostname') {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
          <Text color="cyan" bold>{'Step 1 of 3 — Pick a hostname'}</Text>
          <Text color="gray">{'─'.repeat(56)}</Text>
          <Text color="white">{'Enter the hostname you want clients to connect to. The parent domain'}</Text>
          <Text color="white">{'must already be added to your Cloudflare account.'}</Text>
          <Text color="gray" dimColor>{'  Examples:  pg.example.com   db.eric-weightloss.app   wt.example.com'}</Text>
          <Box marginTop={1}>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={hostname}
              onChange={v => { setHostname(v); setError(null); }}
              onSubmit={v => buildAndShow(v.trim().toLowerCase())}
              placeholder="pg.example.com"
            />
          </Box>
          {!!error && <Text color="red">{`  ${error}`}</Text>}
          <Text color="gray" dimColor>{'  [Enter] continue   [Esc] back'}</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'review' && built) {
    const lines = built.serverScript.split('\n');
    const previewLines = lines.slice(0, 60);
    const remaining = Math.max(0, lines.length - previewLines.length);
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
          <Text color="cyan" bold>{'Step 2 of 3 — Run on the VPS'}</Text>
          <Text color="gray">{'─'.repeat(56)}</Text>
          <Text color="white">
            {'Tunnel name: '}<Text color="green">{built.tunnelName}</Text>
            {'   →   '}<Text color="green">{built.hostname}</Text>
            {' → '}<Text color="green">{`tcp://localhost:${instance.port}`}</Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">{'Save the script to a file and run it as root, e.g.:'}</Text>
            <Text color="green">{'  curl -fsSL https://your-host/cf-tunnel.sh | sudo bash'}</Text>
            <Text color="gray">{'  — or paste it interactively:'}</Text>
            <Text color="green">{'  sudo bash <<\'PGMTUN\''}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
            {previewLines.map((line, i) => (
              <Text key={i} color="gray">{line}</Text>
            ))}
            {remaining > 0 && (
              <Text color="yellow" dimColor>{`  … (${remaining} more lines — your terminal scroll-back has the full script if you copied it whole) …`}</Text>
            )}
            <Text color="green">{'PGMTUN'}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">{'During the run cloudflared will print a one-time login URL.'}</Text>
            <Text color="gray">{'Open it in any browser, sign in to Cloudflare, and select the parent zone'}</Text>
            <Text color="white">{`for ${built.hostname}. The script will then continue automatically.`}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="green" bold>{'[Enter] '}</Text><Text color="white">{'show client command   '}</Text>
            <Text color="gray" bold>{'[Esc] '}</Text><Text color="gray">{'change hostname'}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (step === 'client' && built) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="green" paddingX={2} flexDirection="column">
          <Text color="green" bold>{'Step 3 of 3 — Connect from your laptop'}</Text>
          <Text color="gray">{'─'.repeat(56)}</Text>
          <Text color="white">{'Install cloudflared locally (one time, on Windows):'}</Text>
          <Text color="cyan">{'  winget install --id Cloudflare.cloudflared'}</Text>
          <Text color="gray" dimColor>{'  (or download cloudflared-windows-amd64.exe from the Cloudflare GitHub release page)'}</Text>

          <Box marginTop={1} flexDirection="column">
            <Text color="white">{'Then in one terminal — keep it running:'}</Text>
            <Text color="green" bold>{`  ${built.clientCommand}`}</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text color="white">{'In a second terminal:'}</Text>
            <Text color="green" bold>{`  psql -h 127.0.0.1 -p ${instance.port} -U ${instance.superuser} -d postgres`}</Text>
            <Text color="gray" dimColor>{'  Connection URL form:'}</Text>
            <Text color="gray">{`    postgresql://${instance.superuser}:<password>@127.0.0.1:${instance.port}/postgres`}</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text color="gray">{'How traffic flows:'}</Text>
            <Text color="gray">{`  psql → 127.0.0.1:${instance.port}`}</Text>
            <Text color="gray">{`     → cloudflared (your laptop)`}</Text>
            <Text color="gray">{`     → Cloudflare edge → ${built.hostname}`}</Text>
            <Text color="gray">{`     → cloudflared (VPS, outbound only) → localhost:${instance.port}`}</Text>
            <Text color="gray">{`     → PostgreSQL`}</Text>
          </Box>

          <Box marginTop={1}>
            <Text color="green" bold>{'[Enter / Esc] '}</Text><Text color="white">{'done'}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return <Text color="red">{'Unknown step.'}</Text>;
};
