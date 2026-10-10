import { isSafeExternalUrl } from "../../../shared/url";

export type TextPart = { text: string; href?: string };

// Only http(s) candidates are ever considered, so javascript:, data:, file: and friends stay plain text.
const URL_CANDIDATE = /\bhttps?:\/\/[^\s<>"]+/gi;
const TRAILING = /[.,;:!?'"…)\]}]$/;

/** Sentence punctuation after a link is not part of it; a ")" stays when the link opened one (wiki links). */
function trimTrailing(url: string): string {
  while (TRAILING.test(url)) {
    if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
    url = url.slice(0, -1);
  }
  return url;
}

/** Plain text split into text and link parts (rendered as React text, never as HTML). */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const url = trimTrailing(match[0]);
    const start = match.index;
    let valid = false;
    try {
      valid = isSafeExternalUrl(url) && new URL(url).hostname !== "";
    } catch {
      valid = false;
    }
    if (!valid) continue;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/**
 * Composer/editor keys: Enter submits, Shift+Enter is a newline, and the Enter that confirms an IME composition
 * (Vietnamese Telex/VNI, CJK...) never submits: `isComposing` is set during it, and Chromium reports keyCode 229.
 */
export function isSubmitKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}

export const MAX_MESSAGE_LENGTH = 2000; // messageContentSchema in @loop/shared
/** The counter shows once this close to the limit. */
export const COUNTER_FROM = MAX_MESSAGE_LENGTH - 200;

/** Initials for avatars: first letters of the first two words ("Nhóm Bạn Thân" -> "NB"), else the first two chars. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const chars = words.length > 1 ? [words[0], words[1]].map((w) => [...w][0]) : [...words[0]].slice(0, 2);
  return chars.join("").toLocaleUpperCase("vi-VN");
}

export const AVATAR_COLORS = 6; // --color-avatar-1..6 in styles.css (each checked against ink in theme.test.ts)
/** The same id always gets the same colour. */
export function avatarColor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % AVATAR_COLORS) + 1;
}
