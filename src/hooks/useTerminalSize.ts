import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * Returns current terminal dimensions.
 *
 * Ink v3 already subscribes to stdout `resize` internally and re-renders the
 * entire component tree when the terminal is resized. We simply read the
 * current values at render time — no state, no effect, no extra listener —
 * so there is no second re-render and no ghost-frame artifacts.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  return {
    columns: stdout?.columns ?? 80,
    rows:    stdout?.rows    ?? 24,
  };
}
