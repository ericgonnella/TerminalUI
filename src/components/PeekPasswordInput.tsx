import React, { useState, useRef, useEffect } from 'react';
import { Text, useInput } from 'ink';
import { mutedColor } from '../theme';

interface PeekPasswordInputProps {
  value:       string;
  onChange:    (v: string) => void;
  onSubmit:    (v: string) => void;
  placeholder?: string;
}

/**
 * Password input that briefly reveals each newly-typed character for 600ms
 * before masking it to '*'.  No stored cursor state beyond the last typed index.
 */
export const PeekPasswordInput: React.FC<PeekPasswordInputProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder = '',
}) => {
  const [peekIdx,   setPeekIdx]  = useState(-1);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useInput((input, key) => {
    // Let arrow keys / tab / escape propagate to parent handlers unmodified
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    if (key.tab || key.escape) return;

    if (key.return) {
      onSubmit(value);
      return;
    }

    if (key.backspace || key.delete) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setPeekIdx(-1);
      onChange(value.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const newVal = value + input;
      const idx    = newVal.length - 1;
      onChange(newVal);
      setPeekIdx(idx);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (mountedRef.current) setPeekIdx(-1);
      }, 600);
    }
  });

  if (value.length === 0) {
    return <Text color={mutedColor}>{placeholder}</Text>;
  }

  const display = value.split('').map((ch, i) => i === peekIdx ? ch : '*').join('') + '▋';
  return <Text color="green">{display}</Text>;
};
