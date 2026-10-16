import type { PttStatus } from "../shared/ptt";
import type { Settings } from "../shared/settings";

/** One key press or release, with the key already named like an Electron accelerator ("M", "F13", "Space"). */
export type KeyEvent = { type: "down" | "up"; key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
/** The system-wide keyboard listener (key-hook.ts wraps uiohook-napi); tests pass a fake. */
export type KeyHook = { start(onKey: (e: KeyEvent) => void): void; stop(): void };

/** The mic closes this long after the key is released, so the end of a word is not clipped. */
export const PTT_RELEASE_DELAY_MS = 200;

type Binding = Pick<KeyEvent, "key" | "ctrl" | "alt" | "shift" | "meta">;

/** An accelerator ("Control+Space", "F13") -> the key and exactly which modifiers must be down with it. */
export function parseBinding(accelerator: string, platform: string): Binding | null {
  const parts = accelerator.split("+");
  const key = parts.pop();
  if (!key) return null;
  const has = (...names: string[]) => parts.some((p) => names.includes(p));
  return {
    key,
    ctrl: has("Control") || (platform !== "darwin" && has("CommandOrControl")),
    meta: has("Command", "Super") || (platform === "darwin" && has("CommandOrControl")),
    alt: has("Alt"),
    shift: has("Shift"),
  };
}

type Deps = {
  /** null = the native module cannot load here. Called at most once. */
  loadHook: () => KeyHook | null;
  /** The bound key went down (true) or, after the release delay, up (false). The ONLY thing that leaves this module. */
  send: (held: boolean) => void;
  /** macOS asks the user to allow keyboard listening; `prompt` shows that dialog when it is missing. Elsewhere always true. */
  permitted: (prompt: boolean) => boolean;
  platform: string;
};

/**
 * Push-to-talk in the main process. The key hook runs only while push-to-talk is on, a key is bound AND the renderer
 * says it is in a voice room. Every key event is compared with the binding right here and dropped unless it is that
 * key: the renderer only ever hears "held" / "released", so no keystroke of the user's leaves the main process.
 */
export function createPtt({ loadHook, send, permitted, platform }: Deps) {
  let hook: KeyHook | null | undefined; // undefined = not tried yet
  let broken = false; // start() threw
  let inRoom = false;
  let binding: Binding | null = null;
  let running = false;
  let held = false;
  let releasing: ReturnType<typeof setTimeout> | undefined;

  const getHook = () => (hook === undefined ? (hook = loadHook()) : hook);

  const release = () => {
    clearTimeout(releasing);
    releasing = undefined;
    if (!held) return;
    held = false;
    send(false);
  };

  function onKey(e: KeyEvent) {
    if (!binding || e.key !== binding.key) return;
    if (e.type === "up") {
      if (held && !releasing)
        releasing = setTimeout(() => {
          releasing = undefined;
          release();
        }, PTT_RELEASE_DELAY_MS);
      return;
    }
    if (held) {
      // a key-repeat, or a new press inside the release delay: still held, nothing to send
      clearTimeout(releasing);
      releasing = undefined;
      return;
    }
    if (e.ctrl === binding.ctrl && e.alt === binding.alt && e.shift === binding.shift && e.meta === binding.meta) {
      held = true;
      send(true);
    }
  }

  function stop() {
    if (!running) return;
    running = false;
    try {
      hook?.stop();
    } catch {
      // already stopped
    }
    release(); // never leave the mic open because the hook went away
  }

  function sync() {
    if (!binding || !inRoom) return stop();
    const h = getHook();
    if (running || !h || broken || !permitted(true)) return;
    try {
      h.start(onKey);
      running = true;
    } catch {
      broken = true;
    }
  }

  const status = (): PttStatus => (!getHook() || broken ? "unavailable" : permitted(false) ? "ready" : "permission");

  return {
    apply({ pttMode, pttKey }: Pick<Settings, "pttMode" | "pttKey">) {
      const next = pttMode && pttKey ? parseBinding(pttKey, platform) : null;
      if (JSON.stringify(next) !== JSON.stringify(binding)) release(); // a held old key must not stay held
      binding = next;
      sync();
    },
    /** The renderer is in (or left) a voice room; answers with whether push-to-talk can work now. */
    setRoom(value: boolean): PttStatus {
      inRoom = value;
      sync();
      return status();
    },
    status,
    dispose: stop,
  };
}
