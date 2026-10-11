/** The two icons a participant's state can show. */
export type Indicator = "mic" | "deaf";
/** What is known about someone; undefined = unknown (shows nothing). */
export type VoiceFlags = { micOff?: boolean; deafened?: boolean };

/** THE one place state becomes icons, for the channel list and the tiles alike. Deafening mutes the mic, so it shows both. */
export const indicatorsOf = ({ micOff, deafened }: VoiceFlags): Indicator[] => (deafened ? ["mic", "deaf"] : micOff ? ["mic"] : []);

// ponytail: the deafen flag travels as LiveKit participant metadata (the server grants canUpdateOwnMetadata). It is
// cosmetic only: a client may lie about its own icon, so it is read defensively and never used for any decision.
export const META_MAX = 64;
export const encodeDeafened = (deafened: boolean) => (deafened ? JSON.stringify({ deafened: true }) : "");

/** True only for a small JSON object `{ "deafened": true }`; anything else (empty, oversized, malformed, other types) is false. */
export function parseDeafened(raw: string | undefined): boolean {
  if (!raw || raw.length > META_MAX) return false;
  try {
    const v: unknown = JSON.parse(raw);
    return !!v && typeof v === "object" && (v as { deafened?: unknown }).deafened === true;
  } catch {
    return false;
  }
}
