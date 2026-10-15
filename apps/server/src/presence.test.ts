import type { PresenceStatus, StatusPref } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { effectiveStatus } from "./presence.js";

// Every preference against: no socket, one active, one away, several mixed, several all away.
const SOCKETS: Record<string, boolean[]> = { none: [], active: [false], away: [true], mixed: [true, false, true], allAway: [true, true] };
const TABLE: Record<StatusPref, Record<keyof typeof SOCKETS, PresenceStatus>> = {
  online: { none: "offline", active: "online", away: "idle", mixed: "online", allAway: "idle" },
  idle: { none: "offline", active: "idle", away: "idle", mixed: "idle", allAway: "idle" },
  dnd: { none: "offline", active: "dnd", away: "dnd", mixed: "dnd", allAway: "dnd" },
  invisible: { none: "offline", active: "offline", away: "offline", mixed: "offline", allAway: "offline" },
};

describe("effectiveStatus", () => {
  const cases = Object.entries(TABLE).flatMap(([pref, row]) => Object.entries(row).map(([s, want]) => [pref as StatusPref, s, want] as const));
  it.each(cases)("%s with %s sockets -> %s", (pref, sockets, want) => {
    expect(effectiveStatus(pref, SOCKETS[sockets]!)).toBe(want);
  });
});
