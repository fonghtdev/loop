/** The icons a participant's state can show; the `server*` ones (red variant) are a moderator's doing. */
export type Indicator = "mic" | "deaf" | "serverMic" | "serverDeaf";
/** What is known about someone; undefined = unknown (shows nothing). `server*` come from the server only. */
export type VoiceFlags = { micOff?: boolean; deafened?: boolean; serverMute?: boolean; serverDeafen?: boolean };

/**
 * THE one place state becomes icons, for the channel list and the tiles alike. Deafening mutes the mic, so it shows
 * both; a server mute / deafen replaces the person's own icon of the same kind (and a server deafen takes the mic too).
 */
export function indicatorsOf({ micOff, deafened, serverMute, serverDeafen }: VoiceFlags): Indicator[] {
  const mic: Indicator | null = serverMute || serverDeafen ? "serverMic" : deafened || micOff ? "mic" : null;
  const deaf: Indicator | null = serverDeafen ? "serverDeaf" : deafened ? "deaf" : null;
  return [mic, deaf].filter((i): i is Indicator => i !== null);
}

// ponytail: the deafen flag and the streams we watch travel as LiveKit participant metadata (the server grants
// canUpdateOwnMetadata). They are cosmetic only: a client may lie about its own icon / viewing, so they are read
// defensively and never used for any decision.
export const META_MAX = 512;
/** At most this many streams are announced (a room holds 25 people; nobody watches more than a few). */
export const WATCHING_MAX = 8;
export type MetaFlags = { deafened: boolean; watching: string[] };
export const encodeFlags = ({ deafened, watching }: MetaFlags) => (deafened || watching.length ? JSON.stringify({ ...(deafened && { deafened: true }), ...(watching.length && { watching: watching.slice(0, WATCHING_MAX) }) }) : "");

/** Only a small JSON object counts; anything else (empty, oversized, malformed, wrong types) reads as "nothing". */
export function parseFlags(raw: string | undefined): MetaFlags {
  const none: MetaFlags = { deafened: false, watching: [] };
  if (!raw || raw.length > META_MAX) return none;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return none;
    const { deafened, watching } = v as { deafened?: unknown; watching?: unknown };
    const ids = Array.isArray(watching) ? watching.filter((id): id is string => typeof id === "string" && id.length <= 64).slice(0, WATCHING_MAX) : [];
    return { deafened: deafened === true, watching: ids };
  } catch {
    return none;
  }
}
