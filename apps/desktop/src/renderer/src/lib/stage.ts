/** Where the main area is: enough to tell what kind of change a navigation is. */
export type StagePlace = { guildId: string | null; channelId: string | null; dmId: string | null; settings: string | null };

/** How far (px) and which way the main area slides in. */
export type Shift = { x: number; y: number };
const STEP = 12;

/**
 * The slide that goes with the fade when the main area changes: another server slides vertically (down the rail =
 * from below), anything else (channel, DM, settings) slides in from the side. null = no transition (nothing changed,
 * or a server only just resolved its first channel, which is the same arrival as opening the server).
 */
export function stageShift(prev: StagePlace, next: StagePlace, guildOrder: string[]): Shift | null {
  if (prev.guildId === next.guildId && prev.channelId === next.channelId && prev.dmId === next.dmId && prev.settings === next.settings) return null;
  if (prev.guildId !== null && prev.guildId === next.guildId && prev.channelId === null && prev.dmId === null && prev.settings === null) return null;
  if (prev.guildId !== next.guildId) {
    const index = (id: string | null) => (id === null ? -1 : guildOrder.indexOf(id));
    return { x: 0, y: index(next.guildId) >= index(prev.guildId) ? STEP : -STEP };
  }
  return { x: STEP, y: 0 };
}
