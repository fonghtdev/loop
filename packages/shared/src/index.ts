import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.js";
import { ALL_PERMISSIONS, CHANNEL_PERMISSIONS } from "./permissions.js";
import { channelTopicSchema, groupDmNameSchema, threadNameSchema } from "./profiles.js";

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

/** Bots: a bot's name is its username (same rules, same uniqueness as people's). */
export const MAX_BOTS_PER_USER = 5;
export const createBotSchema = z.object({ name: usernameSchema });
// `<botUserId>.<secret>`; the server parses it, a malformed one is the same 401 as a wrong one
export const botLoginSchema = z.object({ token: z.string().min(1).max(256) });

export const createGuildSchema = z.object({ name: z.string().trim().min(1).max(100) });

export const channelTypeSchema = z.enum(["TEXT", "VOICE"]);

/** Names of the two categories every guild starts with (also written by the categories migration). */
export const DEFAULT_CATEGORIES = { TEXT: "Kênh văn bản", VOICE: "Kênh thoại" } as const;

export const categorySchema = z.object({
  id: z.string().uuid(),
  guildId: z.string().uuid(),
  name: z.string().min(1).max(100),
  position: z.number().int().min(0),
  createdAt: z.string(),
});
export type Category = z.infer<typeof categorySchema>;

/** Channel as returned by the guild endpoints; `categoryId` null = uncategorised area. */
export const channelSchema = z.object({
  id: z.string().uuid(),
  guildId: z.string().uuid(),
  name: z.string(),
  type: channelTypeSchema,
  position: z.number().int().min(0),
  categoryId: z.string().uuid().nullable(),
  topic: z.string().nullable().optional(), // absent from servers older than profiles
  createdAt: z.string(),
});
export type Channel = z.infer<typeof channelSchema>;

export const channelNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_-]+$/, "chỉ gồm chữ thường, số, - và _");

export const createChannelSchema = z.object({
  name: channelNameSchema,
  type: channelTypeSchema,
  categoryId: z.string().uuid().optional(),
});

/** PATCH /channels/:id; `topic` null clears it. */
export const updateChannelSchema = z
  .object({ name: channelNameSchema, topic: channelTopicSchema.nullable() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

export const categoryNameSchema = z.object({ name: z.string().trim().min(1).max(100) });

/** PUT /guilds/:id/layout: the complete order. Ids must be unique; the server also checks them against the guild. */
export const layoutSchema = z
  .object({
    categories: z.array(z.string().uuid()),
    channels: z.array(z.object({ id: z.string().uuid(), categoryId: z.string().uuid().nullable() })),
  })
  .refine((l) => new Set(l.categories).size === l.categories.length, { message: "duplicate category id" })
  .refine((l) => new Set(l.channels.map((c) => c.id)).size === l.channels.length, { message: "duplicate channel id" })
  .refine((l) => l.channels.every((c) => c.categoryId === null || l.categories.includes(c.categoryId)), {
    message: "channel targets a category missing from `categories`",
  });
export type Layout = z.infer<typeof layoutSchema>;

/** Realtime payloads (user rooms; see apps/server/CLAUDE.md). A channel's position is its order inside categoryId. */
export const channelPlacementSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid().nullable(),
  position: z.number().int().min(0),
});
export const categoryDeletedEventSchema = z.object({
  guildId: z.string().uuid(),
  categoryId: z.string().uuid(),
  channels: z.array(channelPlacementSchema), // the channels that became uncategorised (categoryId null)
});
export const layoutUpdatedEventSchema = z.object({
  guildId: z.string().uuid(),
  categories: z.array(z.object({ id: z.string().uuid(), position: z.number().int().min(0) })),
  channels: z.array(channelPlacementSchema),
});
export type CategoryDeletedEvent = z.infer<typeof categoryDeletedEventSchema>;
export type LayoutUpdatedEvent = z.infer<typeof layoutUpdatedEventSchema>;
// category:created and category:updated carry the Category JSON as in REST; channel:created carries the Channel JSON.

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
    replyToId: z.string().max(64).optional(), // plain string like the attachment ids: any bad one gives the same 400
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

/** Socket `typing` payload: the client is typing in a channel or a DM (never both). Ephemeral, nothing is stored. */
export const typingSchema = z.union([z.object({ channelId: z.string().uuid() }).strict(), z.object({ dmChannelId: z.string().uuid() }).strict()]);
/** Server -> room / user room `typing`: `at` = server time in ms. Exactly one of channelId / dmChannelId. */
export type TypingEvent = { channelId?: string; dmChannelId?: string; userId: string; at: number };

/** PUT /channels/:id/read and /dms/:id/read: the seq of the newest message the caller has seen. */
export const readBodySchema = z.object({ seq: seqSchema }).strict();
/** One conversation of GET /me/unread; both counts are capped at 99, conversations with nothing unread are left out. `parentChannelId` is set for a thread. */
export type UnreadChannel = { channelId: string; guildId: string; parentChannelId?: string; unread: number; mentions: number };
export type UnreadDm = { dmChannelId: string; unread: number; mentions: number };
export type UnreadResponse = { channels: UnreadChannel[]; dms: UnreadDm[] };
/** Socket `read:updated` to the user's own room: another device read up to `lastReadSeq`. */
export type ReadUpdatedEvent = { channelId?: string; dmChannelId?: string; lastReadSeq: string };

/** Threads (apps/server/CLAUDE.md "Luồng"). POST /channels/:channelId/messages/:messageId/thread. */
export const createThreadSchema = z.object({ name: threadNameSchema }).strict();
/** PATCH /threads/:threadId. */
export const updateThreadSchema = z
  .object({ name: threadNameSchema, archived: z.boolean() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to update");
/** GET /channels/:channelId/threads: active threads, or the archived ones with `archived=true`. */
export const threadListQuerySchema = z.object({ archived: z.enum(["true", "false"]).optional() }).strict();
/** At most this many threads per list (newest activity first). */
export const MAX_THREADS_LISTED = 50;
/** Thread JSON (REST, `thread:created` / `thread:updated`, and the starter message's `thread`); `lastMessageAt` = creation, then the newest message. */
export type ThreadDto = {
  id: string;
  guildId: string;
  parentChannelId: string;
  name: string;
  starterMessageId: string | null;
  createdById: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  archived: boolean;
  messageCount: number;
};
export type ThreadDeletedEvent = { id: string; guildId: string; parentChannelId: string; starterMessageId: string | null };

export const MAX_SEARCH_TERMS = 8;
const searchTextSchema = z.string().trim().min(1).max(100).regex(/^[^\0]*$/);
/** GET /guilds/:guildId/messages/search: at least `q` or `authorId`; `before` = seq cursor of the previous page's last row. */
export const guildSearchQuerySchema = z
  .object({
    q: searchTextSchema.optional(),
    authorId: z.string().uuid().optional(),
    channelId: z.string().uuid().optional(),
    before: seqSchema.optional(),
    limit: z.coerce.number().int().min(1).max(25).default(25),
  })
  .strict()
  .refine((s) => s.q !== undefined || s.authorId !== undefined, { message: "q or authorId required" });
export const dmSearchQuerySchema = z
  .object({ q: searchTextSchema, before: seqSchema.optional(), limit: z.coerce.number().int().min(1).max(25).default(25) })
  .strict();
export type SearchResponse<M> = { messages: M[]; hasMore: boolean };

/** The words of a search text (letters and digits, at most MAX_SEARCH_TERMS): the server's tsquery terms and the client's highlight terms. */
export const searchTerms = (q: string) => (q.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_SEARCH_TERMS);

export * from "./attachments.js";
export * from "./audit.js";
export * from "./automod.js";
export * from "./emoji.js";
export * from "./gifs.js";
export * from "./links.js";
export * from "./mentions.js";
export * from "./moderation.js";
export * from "./permissions.js";
export * from "./profiles.js";
export * from "./voice.js";

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

export const roleColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const createRoleSchema = z.object({
  name: roleNameSchema,
  permissions: bitmaskSchema(ALL_PERMISSIONS).default(0),
  color: roleColorSchema.nullish().transform((c) => c ?? null),
});

export const updateRoleSchema = z
  .object({ name: roleNameSchema.optional(), permissions: bitmaskSchema(ALL_PERMISSIONS).optional(), color: roleColorSchema.nullable().optional() })
  .refine((b) => b.name !== undefined || b.permissions !== undefined || b.color !== undefined, "nothing to update");

export const overwriteSchema = z
  .object({ allow: bitmaskSchema(CHANNEL_PERMISSIONS), deny: bitmaskSchema(CHANNEL_PERMISSIONS) })
  .refine((o) => (o.allow & o.deny) === 0, "a bit cannot be both allowed and denied");

export const transferOwnershipSchema = z.object({ userId: z.string().uuid() });

export const friendRequestSchema = z.object({ username: usernameSchema });

// Ids stay plain strings here: a malformed id is a 404 at the route (like a missing one), not a 400.
export const openDmSchema = z.object({ userId: z.string() });

/** A group DM holds the creator plus 2..9 others, so 3..10 people; it can shrink below 3 by leaving and stays until empty. */
export const MAX_GROUP_DM = 10;
export const MIN_GROUP_DM_INVITEES = 2;
/** POST /dms/group. Duplicates are a 400; unknown / non-friend ids a 404 at the route, like POST /dms. */
export const createGroupDmSchema = z
  .object({
    userIds: z
      .array(z.string())
      .min(MIN_GROUP_DM_INVITEES)
      .max(MAX_GROUP_DM - 1)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate user ids"),
    name: groupDmNameSchema.nullable().optional(),
  })
  .strict();
export const addGroupDmParticipantSchema = z.object({ userId: z.string() }).strict();
/** PATCH /dms/:dmId (groups only): null or empty clears the name. */
export const updateGroupDmSchema = z.object({ name: groupDmNameSchema.nullable() }).strict();

export type DmKind = "PAIR" | "GROUP";
export type DmUserDto = { id: string; username: string; displayName: string | null; avatarHash: string | null; online: boolean; status: PresenceStatus };
/** GET /dms item: a pair has `user` (the other person); a group lists every participant (the caller included). */
export type PairDmDto = { id: string; kind: "PAIR"; user: DmUserDto; lastMessageAt: string | null };
export type GroupDmDto = { id: string; kind: "GROUP"; name: string | null; ownerId: string | null; participants: DmUserDto[]; lastMessageAt: string | null };

/** What a user chooses (persisted); `invisible` looks exactly like `offline` to everyone else. */
export const STATUS_PREFS = ["online", "idle", "dnd", "invisible"] as const;
export type StatusPref = (typeof STATUS_PREFS)[number];
/** What others see: computed from the preference and the user's sockets (see apps/server/src/presence.ts). */
export type PresenceStatus = "online" | "idle" | "dnd" | "offline";
export const setStatusSchema = z.object({ status: z.enum(STATUS_PREFS) }).strict();
/** Socket `presence:away` payload: the client went idle (true) or came back (false). */
export const presenceAwaySchema = z.object({ away: z.boolean() }).strict();
export type PresenceUpdateEvent = { userId: string; online: boolean; status: PresenceStatus };
