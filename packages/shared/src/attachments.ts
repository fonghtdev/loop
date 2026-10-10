import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Allowlist: nothing else is accepted (no svg, html, executables or octet-stream). Inline display is images only. */
export const ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/zip",
  "video/mp4",
  "audio/mpeg",
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];
export const INLINE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Display name only (the storage key never comes from it): control and bidi-override characters go, only the
 * last path segment stays, whitespace collapses, at most 255 characters. "" when nothing usable is left.
 */
export function sanitizeFilename(name: string): string {
  const base = name
    .replace(/[\p{Cc}‪-‮⁦-⁩]/gu, "")
    .split(/[/\\]/)
    .filter((s) => s.trim())
    .at(-1)
    ?.replace(/\s+/g, " ")
    .trim();
  return !base || /^\.+$/.test(base) ? "" : Array.from(base).slice(0, 255).join("");
}

/** Exactly one target: a guild channel or a DM. A bad id is the route's 404, not a 400. */
export const createAttachmentSchema = z
  .object({
    filename: z.string().max(2048).transform(sanitizeFilename).pipe(z.string().min(1, "invalid filename")),
    contentType: z.enum(ATTACHMENT_TYPES),
    size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
    channelId: z.string().optional(),
    dmChannelId: z.string().optional(),
  })
  .refine((b) => (b.channelId === undefined) !== (b.dmChannelId === undefined), "exactly one of channelId / dmChannelId");
