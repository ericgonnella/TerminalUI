import type { LogLevel, InstanceStatus } from './types';

// On Windows, ANSI "gray" (bright-black / color index 90) renders near-black
// against dark terminal backgrounds, making descriptive text invisible.
// Use plain white for muted/secondary text on Windows so it is always legible.
// On Linux / macOS the standard gray is clearly visible, so keep it there.
export const mutedColor = process.platform === 'win32' ? 'white' : 'gray';

export const colors = {
  primary:  'cyan',
  success:  'green',
  warning:  'yellow',
  error:    'red',
  muted:    mutedColor,
  accent:   'magenta',
  info:     'cyan',
  white:    'white',
  blue:     'blue',
} as const;

export function getMetricColor(
  value: number,
  warning: number,
  critical: number,
): string {
  if (value >= critical) return colors.error;
  if (value >= warning)  return colors.warning;
  return colors.success;
}

export function getInstanceStatusColor(status: InstanceStatus): string {
  switch (status) {
    case 'running': return colors.success;
    case 'stopped': return colors.warning;
    case 'error':   return colors.error;
    default:        return colors.muted;
  }
}

export function getLevelColor(level: LogLevel): string {
  switch (level) {
    case 'INFO':  return colors.info;
    case 'WARN':  return colors.warning;
    case 'ERROR': return colors.error;
    case 'DEBUG': return colors.muted;
  }
}

export function getLatencyColor(ms: number): string {
  if (ms > 100) return colors.error;
  if (ms > 50)  return colors.warning;
  return colors.success;
}
