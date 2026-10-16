import { z } from "zod";

// Control characters and bidi marks / overrides / isolates: nothing here may reorder or hide text around it.
const BIDI = "\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069";
export const SINGLE_LINE = new RegExp(`^[^\\p{Cc}${BIDI}]*$`, "u");
const MULTI_LINE = new RegExp(`^(?:[^\\p{Cc}${BIDI}]|[\\n\\r\\t])*$`, "u"); // line breaks and tabs are the only controls kept

// Length is counted in characters (code points, as the database CHECKs do), so an emoji counts once.
const maxChars = (max: number) => (s: string) => [...s].length <= max;

/** Trimmed text of at most `max` characters; empty means "none" (null). */
export const optionalText = (max: number, pattern: RegExp) =>
  z.string().trim().refine(maxChars(max), `at most ${max} characters`).pipe(z.string().regex(pattern, "invalid characters")).transform((s) => s || null);

export const displayNameSchema = z.string().trim().min(1).refine(maxChars(32), "at most 32 characters").pipe(z.string().regex(SINGLE_LINE, "invalid characters"));
export const bioSchema = optionalText(190, MULTI_LINE);
export const statusTextSchema = optionalText(128, SINGLE_LINE);
export const channelTopicSchema = optionalText(1024, MULTI_LINE);
/** A group DM's name; empty means none (clients then list the participants). */
export const groupDmNameSchema = optionalText(100, SINGLE_LINE);
/** A thread's name: required, one line, 1..100 characters. */
export const threadNameSchema = z.string().trim().min(1).refine(maxChars(100), "at most 100 characters").pipe(z.string().regex(SINGLE_LINE, "invalid characters"));

/** PATCH /me/profile: a key left out stays as it is, null clears. */
export const updateProfileSchema = z
  .object({ displayName: displayNameSchema.nullable(), bio: bioSchema.nullable(), statusText: statusTextSchema.nullable() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageKind = "avatar" | "banner" | "icon";
export const IMAGE_MAX_BYTES: Record<ImageKind, number> = { avatar: 8 * 1024 * 1024, banner: 10 * 1024 * 1024, icon: 8 * 1024 * 1024 };

/** Step 1 of an image upload; the size limit depends on the kind and is checked by the route. */
export const imageUploadSchema = z
  .object({ contentType: z.enum(IMAGE_TYPES), size: z.number().int().min(1) })
  .strict();
export const imageCompleteSchema = z.object({ id: z.string().max(64) }).strict();

export const updateGuildSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

/** Realtime `user:updated`: the public fields others cache about a user. */
export type UserUpdatedEvent = {
  id: string;
  username: string;
  displayName: string | null;
  avatarHash: string | null;
  bannerHash: string | null;
  statusText: string | null;
};
export type GuildUpdatedEvent = { id: string; name: string; iconHash: string | null };
