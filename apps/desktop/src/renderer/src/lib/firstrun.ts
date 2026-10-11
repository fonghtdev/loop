import { createStore } from "zustand/vanilla";

/**
 * The "Bắt đầu" checklist. Steps that leave a trace in the account's data are DERIVED from it (a server, a friend or
 * a DM exists); the two that leave none (first message sent, first voice join) are remembered per account in
 * localStorage. Rule: shown on Home only while at least one step is open AND the user has not hidden it.
 */
export const STEPS = ["server", "friend", "message", "voice"] as const;
export type Step = (typeof STEPS)[number];
export type Done = Record<Step, boolean>;

/** What the app already knows about the account (counts from the server lists). */
export type Counts = { servers: number; friends: number; dms: number };

/** The events that leave no trace in the data, so they are stored. */
export const EVENTS = ["message", "voice"] as const;
export type AppEvent = (typeof EVENTS)[number];
export type Saved = { events: AppEvent[]; dismissed: boolean };

export const EMPTY_SAVED: Saved = { events: [], dismissed: false };
const key = (userId: string) => `loop.firstRun.${userId}`;

/** Stored text -> Saved; anything unknown (corrupt JSON, wrong shape, foreign events) falls back to empty. */
export function parseSaved(raw: string | null): Saved {
  try {
    const v = JSON.parse(raw ?? "null");
    if (!v || typeof v !== "object") return EMPTY_SAVED;
    const events = Array.isArray(v.events) ? EVENTS.filter((e) => v.events.includes(e)) : [];
    return { events, dismissed: v.dismissed === true };
  } catch {
    return EMPTY_SAVED;
  }
}

export function progress(counts: Counts, saved: Saved): Done {
  return {
    server: counts.servers > 0,
    friend: counts.friends + counts.dms > 0,
    message: saved.events.includes("message"),
    voice: saved.events.includes("voice"),
  };
}

export const doneCount = (done: Done) => STEPS.filter((s) => done[s]).length;
export const allDone = (done: Done) => doneCount(done) === STEPS.length;
/** The one rule for showing the checklist. */
export const shouldShow = (done: Done, saved: Saved) => !saved.dismissed && !allDone(done);
/** The welcome cards: an account with no server and nobody to talk to yet. */
export const isFirstRun = (counts: Counts) => counts.servers + counts.friends + counts.dms === 0;

/** Calls `onComplete` once, when the steps go from some-open to all-done (not when they were done from the start). */
export function completionWatcher(onComplete: () => void) {
  let was: boolean | null = null;
  let fired = false;
  return (done: Done) => {
    const now = allDone(done);
    if (was === false && now && !fired) {
      fired = true;
      onComplete();
    }
    was = now;
  };
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** The per-account saved part. Storage is injected; any storage failure just means "nothing saved". */
export function createFirstRun(storage: () => Storage | undefined) {
  const store = createStore<{ userId: string | null; saved: Saved }>(() => ({ userId: null, saved: EMPTY_SAVED }));
  const write = (userId: string, saved: Saved) => {
    store.setState({ userId, saved });
    try {
      storage()?.setItem(key(userId), JSON.stringify(saved));
    } catch {
      // a lost checklist state is harmless
    }
  };
  return {
    store,
    /** Signed in as `userId`: load that account's state. */
    start(userId: string) {
      let raw: string | null = null;
      try {
        raw = storage()?.getItem(key(userId)) ?? null;
      } catch {
        // unreadable storage = nothing saved
      }
      store.setState({ userId, saved: parseSaved(raw) });
    },
    stop: () => store.setState({ userId: null, saved: EMPTY_SAVED }),
    /** Remembers an event for the signed-in account; true only the first time. */
    record(event: AppEvent) {
      const { userId, saved } = store.getState();
      if (!userId || saved.events.includes(event)) return false;
      write(userId, { ...saved, events: [...saved.events, event] });
      return true;
    },
    dismiss() {
      const { userId, saved } = store.getState();
      if (userId) write(userId, { ...saved, dismissed: true });
    },
  };
}
