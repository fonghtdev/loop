/** The pure rules of watching someone's screen share (Discord-like: nothing plays, or is even downloaded, until Watch). */

export const SCREEN_SOURCES = ["screen_share", "screen_share_audio"] as const;
const isScreenSource = (source: string) => (SCREEN_SOURCES as readonly string[]).includes(source);

export const clampVolume = (v: number, max = 1) => (Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 1);

/** What a track's own <audio> plays at: deafen and its mute both silence it, otherwise the viewer's slider (up to `max`; a person's microphone may go to 200%). */
export const effectiveVolume = (deafened: boolean, muted: boolean, volume: number, max = 1) => (deafened || muted ? 0 : clampVolume(volume, max));

type Pub = { userId: string; source: string; subscribed: boolean };

/**
 * The screen-share publications whose subscription must change: subscribed exactly for the people being watched.
 * Microphone and camera never appear here, whatever the set says.
 */
export function subscriptionChanges<T extends Pub>(watching: readonly string[], pubs: T[]): (T & { subscribe: boolean })[] {
  return pubs.filter((p) => isScreenSource(p.source)).map((p) => ({ ...p, subscribe: watching.includes(p.userId) })).filter((p) => p.subscribe !== p.subscribed);
}

/** Drops people who stopped sharing or left: a stream that ends (or restarts) needs a fresh Watch. */
export const pruneWatching = (watching: string[], sharers: ReadonlySet<string>) => {
  const kept = watching.filter((id) => sharers.has(id));
  return kept.length === watching.length ? watching : kept;
};

/** Who says they are watching `streamerId`'s screen (their own cosmetic claim, see voice-flags); never the streamer. */
export const viewersOf = <T extends { userId: string; watching?: string[] }>(participants: T[], streamerId: string): T[] =>
  participants.filter((p) => p.userId !== streamerId && p.watching?.includes(streamerId));
