import { type AutoModRuleDto, autoModKeywordSchema, MAX_AUTOMOD_KEYWORD_CHARS, MAX_AUTOMOD_KEYWORDS, MAX_AUTOMOD_NAME_CHARS, MAX_AUTOMOD_RULES } from "@loop/shared";
import { t } from "../i18n/t";

export type RuleDraft = { name: string; keywords: string; enabled: boolean };

/** The textarea, one keyword per line: blank lines are skipped, exact repeats dropped (as the server does). */
export const parseKeywords = (text: string) => [...new Set(text.split("\n").map((k) => k.trim()).filter(Boolean))];

/**
 * The form against the server's own rules (shared schemas): a name of 1..60 characters, 1..100 keywords of 1..50
 * characters with a letter or digit. `count` drives the live counter; `line` = the first bad line (1-based) for the message.
 */
export function ruleFormErrors(d: RuleDraft) {
  const keywords = parseKeywords(d.keywords);
  const name = d.name.trim();
  const nameError = !name ? t("validation.required") : [...name].length > MAX_AUTOMOD_NAME_CHARS ? t("automod.errors.nameLong", { max: String(MAX_AUTOMOD_NAME_CHARS) }) : undefined;
  let keywordsError: string | undefined;
  if (!keywords.length) keywordsError = t("automod.errors.noKeywords");
  else if (keywords.length > MAX_AUTOMOD_KEYWORDS) keywordsError = t("automod.errors.tooMany", { max: String(MAX_AUTOMOD_KEYWORDS) });
  else {
    const bad = keywords.find((k) => !autoModKeywordSchema.safeParse(k).success);
    if (bad !== undefined) {
      const why = [...bad].length > MAX_AUTOMOD_KEYWORD_CHARS ? t("automod.errors.keywordLong", { max: String(MAX_AUTOMOD_KEYWORD_CHARS) }) : t("automod.errors.keywordChars");
      keywordsError = t("automod.errors.keyword", { keyword: [...bad].slice(0, 20).join(""), why });
    }
  }
  return { count: keywords.length, name: nameError, keywords: keywordsError, ok: !nameError && !keywordsError };
}

export const draftOf = (r?: AutoModRuleDto): RuleDraft => (r ? { name: r.name, keywords: r.keywords.join("\n"), enabled: r.enabled } : { name: "", keywords: "", enabled: true });

/** Only what changed (PATCH); null when nothing did. */
export function rulePatch(r: AutoModRuleDto, d: RuleDraft) {
  const patch: { name?: string; keywords?: string[]; enabled?: boolean } = {};
  const name = d.name.trim();
  const keywords = parseKeywords(d.keywords);
  if (name !== r.name) patch.name = name;
  if (keywords.join("\n") !== r.keywords.join("\n")) patch.keywords = keywords;
  if (d.enabled !== r.enabled) patch.enabled = d.enabled;
  return Object.keys(patch).length ? patch : null;
}

/** A sixth rule is refused by the server (409): the create button is disabled with this reason instead. */
export const canAddRule = (count: number) => count < MAX_AUTOMOD_RULES;
