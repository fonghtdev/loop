import type { PresenceStatus, StatusPref } from "@loop/shared";

/**
 * The status everyone else sees, from the user's preference and the `away` flag of each of their sockets
 * (all instances). No socket or invisible -> offline; dnd / idle as chosen; online -> idle only when every socket is away.
 */
export function effectiveStatus(pref: StatusPref, away: boolean[]): PresenceStatus {
  if (!away.length || pref === "invisible") return "offline";
  if (pref !== "online") return pref;
  return away.every(Boolean) ? "idle" : "online";
}

/** `{online, status}` as list entries carry them; a missing status (not computed) reads as offline. */
export const presenceFields = (status: PresenceStatus = "offline") => ({ online: status !== "offline", status });
