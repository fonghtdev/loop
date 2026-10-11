import { createStore } from "zustand/vanilla";

export type ToastTone = "ok" | "error";
export type Toast = { id: number; text: string; tone: ToastTone };

export const TOAST_MS = 3000;

type Deps = { ms?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (id: unknown) => void };

/**
 * One small result message at a time ("Đã lưu"). A new one replaces the one on screen and restarts the clock; the clock
 * runs `ms` and stops while the pointer or focus is on the toast (`pause` / `resume` keep the time that was left).
 * Hiding it also clears the pause, because the leave event never arrives for an element that has just gone.
 */
export function createToasts({ ms = TOAST_MS, now = Date.now, setTimer = setTimeout, clearTimer = (id) => clearTimeout(id as never) }: Deps = {}) {
  const store = createStore<{ current: Toast | null }>(() => ({ current: null }));
  let seq = 0;
  let timer: unknown;
  let left = ms;
  let startedAt = 0;
  let paused = false;

  const arm = () => {
    clearTimer(timer);
    startedAt = now();
    timer = setTimer(dismiss, left);
  };
  function dismiss() {
    clearTimer(timer);
    paused = false;
    store.setState({ current: null });
  }
  return {
    store,
    push(text: string, tone: ToastTone = "ok") {
      left = ms;
      store.setState({ current: { id: ++seq, text, tone } });
      if (paused) clearTimer(timer);
      else arm();
    },
    dismiss,
    pause() {
      if (paused || !store.getState().current) return;
      paused = true;
      clearTimer(timer);
      left = Math.max(0, left - (now() - startedAt));
    },
    resume() {
      if (!paused) return;
      paused = false;
      if (store.getState().current) arm();
    },
  };
}

export const toast = createToasts();
