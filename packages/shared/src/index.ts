import { z } from "zod";

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
export const messageContentSchema = z.string().trim().min(1).max(2000).regex(/^[^\0]*$/);

/** Body for both sending and editing a message. */
export const messageBodySchema = z.object({ content: messageContentSchema });

// seq travels as a decimal string (BigInt is not JSON-serializable); 18 digits always fit a Postgres bigint
const seqSchema = z.string().regex(/^\d{1,18}$/);

export const historyQuerySchema = z
  .object({
    before: seqSchema.optional(),
    after: seqSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => !(q.before && q.after), { message: "before and after are mutually exclusive" });
