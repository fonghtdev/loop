export const MAX_REACTION_EMOJI_PER_MESSAGE = 20;

// Pictographs glued by ZWJ / VS16 / skin tone / tag characters (subdivision flags), or a keycap, or a regional-indicator flag.
const SEQUENCE = /^(?=.*\p{Extended_Pictographic})(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|[\u{E0020}-\u{E007F}])+$/u;
const KEYCAP = /^[0-9#*]️?⃣$/u;
const FLAG = /^\p{Regional_Indicator}{2}$/u;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Exactly one Unicode emoji (one grapheme cluster, at most 32 UTF-16 units). No custom emoji yet. */
export function isEmoji(s: string): boolean {
  if (s.length === 0 || s.length > 32) return false;
  const clusters = [...segmenter.segment(s)];
  return clusters.length === 1 && (SEQUENCE.test(s) || KEYCAP.test(s) || FLAG.test(s));
}
