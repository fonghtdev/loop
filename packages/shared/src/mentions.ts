/** A mention travels as plain text `<@userId>` inside the message content; the composer writes it, viewers render it. */
export const MAX_MENTIONS_PER_MESSAGE = 20;
/** Pinned messages per channel / DM. */
export const MAX_PINS_PER_CONVERSATION = 50;

const MENTION_TOKEN = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;
const EVERYONE = /(?<![\w<@])@(everyone|here)(?!\w)/;

/** `<@uuid>` ids in order of appearance, lowercased, deduplicated, at most MAX_MENTIONS_PER_MESSAGE (the rest stay inert text). */
export function mentionIds(content: string): string[] {
  const ids = new Set<string>();
  for (const m of content.matchAll(MENTION_TOKEN)) {
    ids.add(m[1]!.toLowerCase());
    if (ids.size === MAX_MENTIONS_PER_MESSAGE) break;
  }
  return [...ids];
}

/** Literal `@everyone` or `@here` in the text (whether it counts is the server's call: it needs MENTION_EVERYONE). */
export const hasEveryoneMention = (content: string) => EVERYONE.test(content);
