/** The picker's emoji: four groups of 16, so with 8 columns every row is full and Up/Down stay in their column. */
export const EMOJI_COLUMNS = 8;

export const EMOJI_GROUPS = [
  { label: "emoji.group.faces", emoji: ["😀", "😂", "🥹", "😍", "😎", "🤔", "😭", "😡", "🥳", "😴", "🙄", "😅", "🤯", "😱", "🥺", "😇"] },
  { label: "emoji.group.hands", emoji: ["👍", "👎", "👏", "🙌", "🙏", "💪", "👋", "🤝", "✌️", "🤞", "👀", "🫡", "🤌", "🫶", "👊", "🖖"] },
  { label: "emoji.group.symbols", emoji: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "🔥", "✨", "💯", "✅", "❌", "⚠️", "❓"] },
  { label: "emoji.group.things", emoji: ["🎉", "🎂", "🎁", "🏆", "⭐", "🌈", "☕", "🍕", "🍺", "🎮", "🎵", "🚀", "💡", "📌", "💻", "🐱"] },
] as const;

export const EMOJI_FLAT: readonly string[] = EMOJI_GROUPS.flatMap((g) => g.emoji);

/** Where focus goes from cell `i` on an arrow/Home/End key (stays put at an edge). */
export function moveEmojiFocus(i: number, key: string, total = EMOJI_FLAT.length, columns = EMOJI_COLUMNS): number {
  const target = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + columns, ArrowUp: i - columns, Home: 0, End: total - 1 }[key];
  return target === undefined || target < 0 || target >= total ? i : target;
}
