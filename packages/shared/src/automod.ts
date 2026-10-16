import { z } from "zod";
import { SINGLE_LINE } from "./profiles.js";

export const MAX_AUTOMOD_RULES = 5;
export const MAX_AUTOMOD_KEYWORDS = 100;
export const MAX_AUTOMOD_KEYWORD_CHARS = 50;
export const MAX_AUTOMOD_NAME_CHARS = 60;
/** The 403 body of a blocked message: never says which keyword matched. */
export const AUTOMOD_BLOCKED = "Message blocked by this server's rules";

/**
 * Lowercase without accents, one code point at a time so that every index of the result is the index of the same
 * letter in the (NFC) input; a character whose folding would change the length is only lowercased. Same result as the
 * database's `loop_fold` for the accented Latin letters it knows (Vietnamese included, Đ/đ -> d).
 */
export function foldText(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const base = ch === "đ" || ch === "Đ" ? "d" : ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    out += base.length === ch.length ? base : ch.toLowerCase();
  }
  return out;
}

const WORD = /[\p{L}\p{N}\p{M}]+/gu; // one character class repeated: linear, no backtracking
/** Folded words: runs of letters/digits; everything else (spaces, punctuation, emoji) separates them. */
export const wordsOf = (text: string) => foldText(text).match(WORD) ?? [];

/**
 * True when `text` holds one of `keywords` as whole words: "ass" matches "Ass!" but not "class" or "assé"; a phrase
 * matches the same words in a row whatever separates them ("bad word" matches "bad, WORD"). No regex is built from
 * input: words are compared as strings, indexed by a phrase's first word. Worst case (2000 characters x 500
 * keywords of 50 characters) stays in the low milliseconds.
 * ponytail: scripts written without spaces (CJK) form one long word, so a keyword inside it does not match.
 */
export function matchesKeywords(text: string, keywords: string[]) {
  const words = wordsOf(text);
  if (!words.length) return false;
  const byFirst = new Map<string, string[][]>();
  for (const k of keywords) {
    const phrase = wordsOf(k);
    if (!phrase.length) continue;
    const list = byFirst.get(phrase[0]!);
    if (list) list.push(phrase);
    else byFirst.set(phrase[0]!, [phrase]);
  }
  for (let i = 0; i < words.length; i++) {
    for (const phrase of byFirst.get(words[i]!) ?? []) {
      if (i + phrase.length <= words.length && phrase.every((w, j) => words[i + j] === w)) return true;
    }
  }
  return false;
}

const chars = (s: string) => [...s].length;
/** One keyword: trimmed, 1..50 characters, one line, at least one letter or digit (else it could never match). */
export const autoModKeywordSchema = z
  .string()
  .trim()
  .min(1)
  .refine((k) => chars(k) <= MAX_AUTOMOD_KEYWORD_CHARS, `at most ${MAX_AUTOMOD_KEYWORD_CHARS} characters`)
  .refine((k) => SINGLE_LINE.test(k), "invalid characters")
  .refine((k) => wordsOf(k).length > 0, "needs a letter or a digit");

const keywordsSchema = z
  .array(autoModKeywordSchema)
  .min(1)
  .max(MAX_AUTOMOD_KEYWORDS)
  .transform((ks) => [...new Set(ks)]); // exact repeats are dropped, not refused
const ruleName = z.string().trim().min(1).refine((n) => chars(n) <= MAX_AUTOMOD_NAME_CHARS, `at most ${MAX_AUTOMOD_NAME_CHARS} characters`).pipe(z.string().regex(SINGLE_LINE, "invalid characters"));

/** POST /guilds/:guildId/automod/rules. */
export const createAutoModRuleSchema = z.object({ name: ruleName, enabled: z.boolean().default(true), keywords: keywordsSchema }).strict();
/** PATCH /guilds/:guildId/automod/rules/:ruleId: at least one key. */
export const updateAutoModRuleSchema = z
  .object({ name: ruleName, enabled: z.boolean(), keywords: keywordsSchema })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

export type AutoModRuleDto = { id: string; guildId: string; name: string; enabled: boolean; keywords: string[]; createdById: string | null; createdAt: string };
