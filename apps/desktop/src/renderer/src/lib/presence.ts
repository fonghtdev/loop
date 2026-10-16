import { STATUS_PREFS, type PresenceStatus, type StatusPref } from "@loop/shared";
import { createStore } from "zustand/vanilla";
import { t } from "../i18n/t";
import type { SocialEvent } from "./social";

const STATUSES: readonly PresenceStatus[] = ["online", "idle", "dnd", "offline"];

/** Server values are not trusted blindly: anything unknown reads as offline. */
export const asStatus = (v: unknown): PresenceStatus => (STATUSES.includes(v as PresenceStatus) ? (v as PresenceStatus) : "offline");
export const asPref = (v: unknown): StatusPref | null => (STATUS_PREFS.includes(v as StatusPref) ? (v as StatusPref) : null);

/** What to show for someone: offline when unknown, blocked, or while the block list is still unknown (null). */
export const shownStatus = (byUser: Readonly<Record<string, PresenceStatus>>, userId: string, blocked: ReadonlySet<string> | null): PresenceStatus =>
  !blocked || blocked.has(userId) ? "offline" : (byUser[userId] ?? "offline");

/** How the user's own choice looks to them: invisible shows as the offline ring, like it does to everyone else. */
export const dotOfPref = (pref: StatusPref): PresenceStatus => (pref === "invisible" ? "offline" : pref);

/** `shownStatus`, except that we ourselves are what we chose (the server never pushes our own status back to us). */
export const statusShownFor = (byUser: Readonly<Record<string, PresenceStatus>>, userId: string, blocked: ReadonlySet<string> | null, self: { id: string | undefined; pref: StatusPref }): PresenceStatus =>
  userId === self.id ? dotOfPref(self.pref) : shownStatus(byUser, userId, blocked);

export const statusLabel = (status: PresenceStatus) =>
  ({ online: t("presence.online"), idle: t("presence.idle"), dnd: t("presence.dnd"), offline: t("presence.offline") })[status];

/** The rows of the status picker: the dot each choice shows, its label and (where it helps) what it means; `selected` marks the current choice. */
export const statusRows = (current: StatusPref) =>
  STATUS_PREFS.map((pref) => ({
    pref,
    dot: dotOfPref(pref),
    label: pref === "invisible" ? t("presence.invisible") : statusLabel(pref),
    description: ({ online: undefined, idle: undefined, dnd: t("presence.dnd.hint"), invisible: t("presence.invisible.hint") } as const)[pref],
    selected: pref === current,
  }));

type Request = <T>(method: "GET" | "PUT", path: string, body?: unknown) => Promise<T>;

/**
 * Everyone's status (userId -> status, unknown = offline) seeded from the lists that carry it and kept live by
 * `presence:update`, plus the signed-in user's own choice (`mine`: loaded after login, changed by the picker and by
 * `me:status` from other devices). Session-scoped: `clear()` on sign-out.
 */
export function createPresence({ request }: { request: Request }) {
  const store = createStore<{ byUser: Record<string, PresenceStatus>; mine: StatusPref }>(() => ({ byUser: {}, mine: "online" }));
  const merge = (entries: { id: string; status?: PresenceStatus }[]) =>
    store.setState((s) => ({ byUser: { ...s.byUser, ...Object.fromEntries(entries.map((e) => [e.id, asStatus(e.status)])) } }));
  const setMine = (mine: StatusPref) => store.setState({ mine });

  return {
    store,
    /** Records the statuses of a fetched list and hands the list back (so it can sit in a `.then`). */
    seed<T>(entries: { id: string; status?: PresenceStatus }[], data: T): T {
      merge(entries);
      return data;
    },
    /** The social events that carry a status: a live change, and a DM opened by the other side. */
    apply(e: SocialEvent) {
      if (e.type === "presence") merge([{ id: e.userId, status: e.status }]);
      else if (e.type === "dm:new") merge([e.dm.user]);
      else if (e.type === "dm:group") merge(e.dm.participants);
    },
    setMine,
    async loadMine() {
      const pref = asPref((await request<{ status: unknown }>("GET", "/me/status").catch(() => null))?.status);
      if (pref) setMine(pref);
    },
    /** Optimistic: shows at once, goes back when the server refuses (the error is rethrown for the toast). */
    async choose(pref: StatusPref) {
      const before = store.getState().mine;
      setMine(pref);
      try {
        await request("PUT", "/me/status", { status: pref });
      } catch (e) {
        if (store.getState().mine === pref) setMine(before);
        throw e;
      }
    },
    clear: () => store.setState({ byUser: {}, mine: "online" }),
  };
}
