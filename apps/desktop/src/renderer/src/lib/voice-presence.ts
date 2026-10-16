import { createStore } from "zustand/vanilla";

/** `serverMute` / `serverDeafen`: a moderator's state, from the server (never from a client's own metadata). */
export type Seat = { userId: string; username: string; sharing?: boolean; serverMute?: boolean; serverDeafen?: boolean };
type VideoSource = { attach(el: HTMLVideoElement): unknown; detach(el: HTMLVideoElement): unknown };
/** Someone in a voice room as the UI draws them (`video`/`screen` only for people in the room we are connected to; `sharing` = a screen share is published). */
export type Participant = Seat & { isLocal?: boolean; sharing?: boolean; screen?: VideoSource; speaking?: boolean; /** Mic muted/absent, and deafened (their own cosmetic flag): undefined = unknown. */ micOff?: boolean; deafened?: boolean; /** Whose screen shares they are watching (their own cosmetic claim). */ watching?: string[]; video?: VideoSource };

const dedupe = (seats: Seat[]): Seat[] =>
  [...new Map(seats.map((s) => [s.userId, { userId: s.userId, username: s.username, ...(s.sharing && { sharing: true }), ...(s.serverMute === true && { serverMute: true }), ...(s.serverDeafen === true && { serverDeafen: true }) }])).values()];

/**
 * Who is in each watched voice channel, from the REST catch-up and the `voice:update` pushes. A push is always the
 * newest word from the server; a REST answer that was requested before a push arrived is older than it and dropped.
 */
export function createVoicePresence() {
  const store = createStore<{ lists: Record<string, Seat[]> }>(() => ({ lists: {} }));
  const versions = new Map<string, number>(); // pushes seen per channel
  const set = (channelId: string, seats: Seat[]) => store.setState((s) => ({ lists: { ...s.lists, [channelId]: dedupe(seats) } }));
  return {
    store,
    update(channelId: string, seats: Seat[]) {
      versions.set(channelId, (versions.get(channelId) ?? 0) + 1);
      set(channelId, seats);
    },
    /** Call before requesting the REST list; hand the result to `applyFetched`. */
    begin: (channelId: string) => versions.get(channelId) ?? 0,
    applyFetched(channelId: string, begun: number, seats: Seat[]) {
      if ((versions.get(channelId) ?? 0) === begun) set(channelId, seats);
    },
    /** Sign-out or another server: nothing from before may leak into the next view. */
    clear() {
      versions.clear();
      store.setState({ lists: {} });
    },
  };
}

/** Someone's server mute / deafen from the pushed lists (they sit in one voice channel of the open server): a stable string for store selectors. */
export function serverFlagsOf(lists: Record<string, Seat[]>, userId: string): "" | "mute" | "deafen" | "mute deafen" {
  for (const seats of Object.values(lists)) {
    const s = seats.find((x) => x.userId === userId);
    if (s) return s.serverMute && s.serverDeafen ? "mute deafen" : s.serverMute ? "mute" : s.serverDeafen ? "deafen" : "";
  }
  return "";
}

const NONE: Participant[] = []; // one shared empty list, so "nobody" is the same value every time

/**
 * The people to show for a voice channel: while we are connected to it the live room is the truth, otherwise
 * the pushed / fetched list.
 */
export function participantsFor(channelId: string, lists: Record<string, Seat[]>, live: { channelId: string; participants: Participant[] } | null): Participant[] {
  return live?.channelId === channelId ? live.participants : (lists[channelId] ?? NONE);
}
