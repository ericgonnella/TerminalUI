import { useState, useCallback } from 'react';
import type { ScreenDef } from '../types';

const INITIAL: ScreenDef = { name: 'home' };

export interface Navigation {
  screen:  ScreenDef;
  stack:   ScreenDef[];
  push:    (screen: ScreenDef) => void;
  pop:     () => void;
  reset:   () => void;
  canBack: boolean;
}

export function useNavigation(): Navigation {
  const [stack, setStack] = useState<ScreenDef[]>([INITIAL]);

  const push = useCallback((screen: ScreenDef) => {
    setStack(s => [...s, screen]);
  }, []);

  const pop = useCallback(() => {
    setStack(s => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const reset = useCallback(() => {
    setStack([INITIAL]);
  }, []);

  const screen  = stack[stack.length - 1] ?? INITIAL;
  const canBack = stack.length > 1;

  return { screen, stack, push, pop, reset, canBack };
}
