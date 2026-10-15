/** System-wide idle time is polled (cheap, and any app counts as activity); `send` only fires when away flips. */
export const IDLE_AFTER_S = 600;
export const IDLE_POLL_MS = 15_000;

export function createIdleWatch({ getIdleSeconds, send }: { getIdleSeconds: () => number; send: (away: boolean) => void }) {
  let away = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const poll = () => {
    const now = getIdleSeconds() >= IDLE_AFTER_S;
    if (now === away) return;
    away = now;
    send(now);
  };
  return {
    start() {
      timer ??= setInterval(poll, IDLE_POLL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
