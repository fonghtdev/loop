import { hasPermission, mentionIds, Permission } from "@loop/shared";
import { permissionsFor, type Channel, type PermissionData } from "./permissions";

/** Whoever can be picked for an `@mention`: a guild member as the server lists them. */
export type Candidate = { userId: string; username: string; displayName?: string | null; avatarHash?: string | null; isBot?: boolean };
/** A mention inserted into the draft: the visible `@label` stands for `<@id>` on the wire. */
export type MentionToken = { label: string; id: string };

export const MAX_PICKER_ROWS = 8;
const TOKEN = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

export const labelOf = (c: Pick<Candidate, "username" | "displayName">) => c.displayName || c.username;

/** The part of a message the viewer (or the OS notification) reads: `<@id>` shown as `@name`, ids we cannot name stay as they are. */
export function readable(content: string, nameOf: (id: string) => string | undefined) {
  return content.replace(TOKEN, (whole, id: string) => {
    const name = nameOf(id.toLowerCase());
    return name ? `@${name}` : whole;
  });
}

/** Does this message call for my attention: it names me, or it is a (permitted) @everyone / @here. */
export const mentionsMe = (m: { mentions?: string[]; mentionEveryone?: boolean }, myId: string | undefined) =>
  !!myId && (m.mentionEveryone === true || m.mentions?.includes(myId) === true);

/** Lowercase, no accents: "Đạt" is found by "dat". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();

/**
 * The `@query` being typed at the caret: an `@` at the start of the text or after whitespace, then non-space
 * characters up to the caret. null when the caret is not in one (so an e-mail address never opens the picker).
 */
export function activeMention(text: string, caret: number): { start: number; query: string } | null {
  let i = caret;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  if (text[i] !== "@" || caret - i > 33) return null;
  return { start: i, query: text.slice(i + 1, caret) };
}

/** Members matching the query by name or username (accents and case ignored): prefix of the name, then of the username, then of a word, then anywhere. */
export function rankCandidates<T extends Pick<Candidate, "username" | "displayName">>(all: T[], query: string, limit = MAX_PICKER_ROWS): T[] {
  const q = fold(query);
  const score = (c: T) => {
    const name = fold(labelOf(c));
    const user = fold(c.username);
    if (name.startsWith(q)) return 0;
    if (user.startsWith(q)) return 1;
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 2;
    return name.includes(q) || user.includes(q) ? 3 : -1;
  };
  return all
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || labelOf(a.c).localeCompare(labelOf(b.c)))
    .slice(0, limit)
    .map((x) => x.c);
}

/**
 * The picked member as a token: the display name, or the username when another member's token already uses that
 * label (so two tokens of a draft never read the same; ponytail: a username equal to someone's display name still can).
 */
export function tokenFor(c: Candidate, tokens: MentionToken[]): MentionToken {
  const taken = tokens.some((t) => t.label === labelOf(c) && t.id !== c.userId);
  return { label: taken ? c.username : labelOf(c), id: c.userId };
}

/** Replaces the typed `@query` (text[start..caret]) with `@label ` and puts the caret after it. */
export function insertMention(text: string, start: number, caret: number, label: string) {
  const insert = `@${label} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The draft as the wire text: each `@label` that is still intact (after the start or whitespace, not running into
 * more letters) becomes `<@id>`. Edited or deleted labels simply do not match and stay plain text. Every occurrence
 * of an inserted label converts, longest label first so "@Ann Lee" is not read as "@Ann".
 */
export function toWire(text: string, tokens: MentionToken[]) {
  if (!tokens.length) return text;
  const byLabel = new Map(tokens.map((t) => [t.label, t.id]));
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const re = new RegExp(`(^|\\s)@(${labels.join("|")})(?![\\p{L}\\p{N}_])`, "gu");
  return text.replace(re, (_, lead: string, label: string) => `${lead}<@${byLabel.get(label)}>`);
}

/** The wire text back into a draft (to edit a sent message): known ids become `@name` tokens, unknown ones stay `<@id>`. */
export function toDraft(content: string, nameOf: (id: string) => string | undefined) {
  const tokens: MentionToken[] = [];
  for (const id of mentionIds(content)) {
    const label = nameOf(id);
    if (label && !tokens.some((t) => t.label === label)) tokens.push({ label, id });
  }
  const byId = new Map(tokens.map((t) => [t.id, t.label]));
  // a token glued to a letter ("x<@id>", "<@id>x") would not convert back from "@name", so it stays raw
  const glued = (str: string, at: number, len: number) => (at > 0 && !/\s/.test(str[at - 1]!)) || /[\p{L}\p{N}_]/u.test(str[at + len] ?? "");
  return {
    text: content.replace(TOKEN, (whole, id: string, at: number, str: string) => (byId.has(id.toLowerCase()) && !glued(str, at, whole.length) ? `@${byId.get(id.toLowerCase())}` : whole)),
    tokens,
  };
}

/** Who the picker offers in a channel: members (not us) who can see it, so a mention cannot name someone who would never read it. */
export function mentionable(data: PermissionData, channel: Pick<Channel, "overwrites"> | undefined, myId: string | undefined): Candidate[] {
  if (!channel) return [];
  return data.members.filter((m) => m.userId !== myId && hasPermission(permissionsFor({ ...data, userId: m.userId }, channel), Permission.VIEW_CHANNEL));
}
