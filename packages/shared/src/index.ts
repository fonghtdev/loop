import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.js";
import { ALL_PERMISSIONS, CHANNEL_PERMISSIONS } from "./permissions.js";

export const usernameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9_.]+$/, "chỉ gồm chữ thường, số, _ và .");

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const passwordSchema = z.string().min(8).max(128);

export const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
});

// password is not length-checked on login: wrong length is just a wrong password
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().max(128),
});

export const refreshTokenBodySchema = z.object({ refreshToken: z.string().min(1).max(256) });

export const createGuildSchema = z.object({ name: z.string().trim().min(1).max(100) });

export const channelTypeSchema = z.enum(["TEXT", "VOICE"]);

export const createChannelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_-]+$/, "chỉ gồm chữ thường, số, - và _"),
  type: channelTypeSchema,
});

export const createInviteSchema = z.object({
  expiresInSeconds: z
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 60 * 60)
    .optional(),
  maxUses: z.number().int().min(1).max(1000).optional(),
});

// Postgres text cannot hold NUL bytes, so reject them here instead of failing with a 500
export const messageContentSchema = z.string().trim().max(2000).regex(/^[^\0]*$/);

/** Sending: text, attachments or both. Ids stay plain strings: the route gives every bad one the same 400. */
export const messageBodySchema = z
  .object({
    content: messageContentSchema.default(""),
    attachmentIds: z
      .array(z.string().max(64))
      .max(MAX_ATTACHMENTS_PER_MESSAGE)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate attachment")
      .default([]),
  })
  .refine((b) => b.content !== "" || b.attachmentIds.length > 0, "content or attachment required");

/** Editing changes text only; the route requires non-empty text unless the message has attachments. */
export const editMessageSchema = z.object({ content: messageContentSchema.default("") });

// seq travels as a decimal string (BigInt is not JSON-serializable); 18 digits always fit a Postgres bigint
const seqSchema = z.string().regex(/^\d{1,18}$/);

export const historyQuerySchema = z
  .object({
    before: seqSchema.optional(),
    after: seqSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => !(q.before && q.after), { message: "before and after are mutually exclusive" });

export * from "./attachments.js";
export * from "./permissions.js";

// Only known bits; anything else is a client bug or a probe, so 400 rather than silently masking.
const bitmaskSchema = (known: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(known)
    .refine((n) => (n & ~known) === 0, "unknown permission bits");

export const roleNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((n) => n !== "@everyone", "tên này dành cho vai trò mặc định");

export const createRoleSchema = z.object({
  name: roleNameSchema,
  permissions: bitmaskSchema(ALL_PERMISSIONS).default(0),
});

export const updateRoleSchema = z
  .object({ name: roleNameSchema.optional(), permissions: bitmaskSchema(ALL_PERMISSIONS).optional() })
  .refine((b) => b.name !== undefined || b.permissions !== undefined, "nothing to update");

export const overwriteSchema = z
  .object({ allow: bitmaskSchema(CHANNEL_PERMISSIONS), deny: bitmaskSchema(CHANNEL_PERMISSIONS) })
  .refine((o) => (o.allow & o.deny) === 0, "a bit cannot be both allowed and denied");

export const transferOwnershipSchema = z.object({ userId: z.string().uuid() });

export const friendRequestSchema = z.object({ username: usernameSchema });

// Ids stay plain strings here: a malformed id is a 404 at the route (like a missing one), not a 400.
export const openDmSchema = z.object({ userId: z.string() });
