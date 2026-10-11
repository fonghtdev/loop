import { useEffect, useRef, useState } from "react";

/** How long "Đã sao chép" stays before the button is back to idle. */
export const COPIED_MS = 1500;

/**
 * idle -> copied -> idle: `copied()` (re)starts the timer, `reset()` and `dispose()` stop it. A second copy while
 * "copied" restarts the full time, so it never flips back early.
 */
export function createCopyState(onChange: (copied: boolean) => void, ms = COPIED_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    copied() {
      stop();
      onChange(true);
      timer = setTimeout(() => {
        timer = undefined;
        onChange(false);
      }, ms);
    },
    reset() {
      stop();
      onChange(false);
    },
    dispose: stop,
  };
}

/** Copies text; `copied` is true for ~1.5 s after a success (the "Đã sao chép" feedback). */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const state = useRef<ReturnType<typeof createCopyState>>(null);
  state.current ??= createCopyState(setCopied);
  const machine = state.current;
  useEffect(() => machine.dispose, [machine]);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      machine.copied();
    } catch {
      machine.reset();
    }
  };
  return { copied, copy };
}
