import { createStore } from "zustand/vanilla";
import { t } from "../i18n/t";
import type { Voice } from "./voice";

export type CallEvent =
  | { type: "incoming"; dmChannelId: string; from: { id: string; username: string }; video: boolean }
  | { type: "declined"; dmChannelId: string; by: { id: string } }
  | { type: "ended"; dmChannelId: string };

export type Incoming = { dmId: string; from: { id: string; username: string }; video: boolean };
/** An outgoing call nobody has answered yet; `sessionId` ties it to the voice session that placed it. */
export type Ringing = { dmId: string; name: string; sessionId: number };

/** The caller gives up after this long. ponytail: server has no ring timeout; upgrade = server-side expiry. */
export const RING_MS = 45_000;
/**
 * `call:ended` carries only the DM id, and the server may repeat it (up to ~4 times) after a call ends, so a
 * repeat can arrive after the user has already started a NEWER call in the same DM. A call younger than this is
 * therefore never ended by that event (LiveKit's own disconnect still ends it for real).
 */
export const FRESH_CALL_MS = 3_000;

type Deps = {
  voice: Pick<Voice, "store" | "joinDm" | "leave" | "notify">;
  request: (method: "POST", path: string) => Promise<unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
};

/**
 * Call states, derived from three things: `incoming` (the dialog), `ringing` (we placed a call and nobody has
 * picked up) and the voice session itself (a connected DM session = active). idle = none of them.
 * Events are scoped by DM id and ignored when they do not belong to what is on screen.
 */
export function createCalls({ voice, request, now = Date.now, setTimer = setTimeout, clearTimer = (id) => clearTimeout(id as never) }: Deps) {
  const store = createStore<{ incoming: Incoming | null; ringing: Ringing | null }>(() => ({ incoming: null, ringing: null }));
  const get = store.getState;
  let timer: unknown;

  const stopRinging = () => {
    clearTimer(timer);
    store.setState({ ringing: null });
  };
  const session = () => voice.store.getState();
  const inDm = (dmId: string) => session().target?.kind === "dm" && session().target?.id === dmId;
  const live = () => ["connected", "reconnecting"].includes(session().status);

  // ringing stops when the placing session is over or the other side is in the room
  voice.store.subscribe((s) => {
    const r = get().ringing;
    if (r && (s.sessionId !== r.sessionId || s.status === "idle" || s.status === "disconnected" || s.participants.length > 1)) stopRinging();
  });

  async function start(dmId: string, name: string, video: boolean) {
    if (get().incoming?.dmId === dmId) store.setState({ incoming: null }); // calling back = answering
    stopRinging();
    if (!(await voice.joinDm(dmId, name, video))) return;
    const s = session();
    if (s.participants.length > 1) return; // the other side was already there: an answer, nobody to ring
    store.setState({ ringing: { dmId, name, sessionId: s.sessionId } });
    timer = setTimer(() => {
      if (get().ringing?.sessionId !== s.sessionId) return;
      voice.leave();
      voice.notify(t("call.noAnswer", { name }));
    }, RING_MS);
  }

  return {
    store,
    start,
    /** Caller hangs up before the answer. */
    cancel() {
      if (!get().ringing) return;
      stopRinging();
      voice.leave();
    },
    async accept() {
      const inc = get().incoming;
      if (!inc) return;
      store.setState({ incoming: null });
      stopRinging();
      await voice.joinDm(inc.dmId, inc.from.username, inc.video);
    },
    async decline() {
      const inc = get().incoming;
      if (!inc) return;
      store.setState({ incoming: null });
      try {
        await request("POST", `/dms/${inc.dmId}/call/decline`);
      } catch {
        // the caller times out on its own
      }
    },
    handle(e: CallEvent) {
      if (e.type === "incoming") {
        // a ring for the call we are already in is stale
        if (inDm(e.dmChannelId) && live()) return;
        return store.setState({ incoming: { dmId: e.dmChannelId, from: e.from, video: e.video } });
      }
      if (e.type === "declined") {
        const r = get().ringing;
        if (r?.dmId !== e.dmChannelId) return;
        stopRinging();
        voice.leave();
        return voice.notify(t("call.declined", { name: r.name }));
      }
      // ended: idempotent, and only for the call it belongs to
      if (get().incoming?.dmId === e.dmChannelId) store.setState({ incoming: null }); // the caller gave up
      if (inDm(e.dmChannelId) && live() && now() - session().startedAt >= FRESH_CALL_MS) {
        stopRinging();
        voice.leave();
        voice.notify(t("call.ended"));
      }
    },
    /** Sign-out: nothing rings any more. */
    reset() {
      stopRinging();
      store.setState({ incoming: null });
    },
  };
}
