import { useState, useCallback, useEffect } from 'react';

export interface AsyncState<T> {
  data:    T | null;
  loading: boolean;
  error:   string | null;
  reload:  () => void;
}

/**
 * Wraps an async factory function, exposing loading/error/data state.
 * Re-runs whenever `deps` change (same semantics as useEffect).
 */
export function useAsync<T>(
  factory:  () => Promise<T>,
  deps:     unknown[],
): AsyncState<T> {
  const [data,    setData]    = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [tick,    setTick]    = useState(0);

  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    factory()
      .then(result => {
        if (!cancelled) { setData(result); setLoading(false); }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, error, reload };
}
