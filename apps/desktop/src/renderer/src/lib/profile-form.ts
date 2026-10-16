import { bioSchema, displayNameSchema, statusTextSchema } from "@loop/shared";
import { t } from "../i18n/t";

export type ProfileDraft = { displayName: string; bio: string; statusText: string };
export type ProfileFields = { displayName: string | null; bio: string | null; statusText: string | null };
type Patch = Partial<ProfileFields>;

export const LIMITS = { displayName: 32, bio: 190, statusText: 128 } as const;
/** Characters as the server counts them (code points: an emoji is one). */
export const chars = (s: string) => [...s.trim()].length;

export const draftOf = (p: Partial<ProfileFields>): ProfileDraft => ({ displayName: p.displayName ?? "", bio: p.bio ?? "", statusText: p.statusText ?? "" });

export const sameDraft = (a: ProfileDraft, b: ProfileDraft) => a.displayName === b.displayName && a.bio === b.bio && a.statusText === b.statusText;

type Schema = typeof bioSchema | typeof statusTextSchema | typeof displayNameSchema;
const SCHEMAS: Record<keyof ProfileDraft, Schema> = { displayName: displayNameSchema, bio: bioSchema, statusText: statusTextSchema };

/** The value the server would store: trimmed, empty = null. undefined when the text is not acceptable. */
function normalized(field: keyof ProfileDraft, text: string): string | null | undefined {
  if (field === "displayName" && text.trim() === "") return null; // a cleared name falls back to the username
  const r = SCHEMAS[field].safeParse(text);
  return r.success ? r.data : undefined;
}

/** A message per field that cannot be saved (the same schemas as the server), none for the rest. */
export function draftErrors(d: ProfileDraft): Partial<Record<keyof ProfileDraft, string>> {
  const errors: Partial<Record<keyof ProfileDraft, string>> = {};
  for (const f of Object.keys(LIMITS) as (keyof ProfileDraft)[]) {
    if (normalized(f, d[f]) !== undefined) continue;
    errors[f] = chars(d[f]) > LIMITS[f] ? t("profile.errors.long", { max: String(LIMITS[f]) }) : t("profile.errors.chars");
  }
  return errors;
}

/** Only the fields that differ from what is stored (null = clear); null when nothing changed or something is invalid. */
export function profilePatch(current: Partial<ProfileFields>, d: ProfileDraft): Patch | null {
  if (Object.keys(draftErrors(d)).length) return null;
  const patch: Patch = {};
  for (const f of Object.keys(LIMITS) as (keyof ProfileDraft)[]) {
    const next = normalized(f, d[f]) ?? null;
    if (next !== (current[f] ?? null)) patch[f] = next;
  }
  return Object.keys(patch).length ? patch : null;
}
