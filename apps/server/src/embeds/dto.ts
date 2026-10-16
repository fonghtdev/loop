import type { Prisma } from "@prisma/client";

/** Thumbnails live under this prefix only, at a key the server made up (never from input). */
export const thumbKey = (hash: string) => `embeds/${hash}`;
export const thumbnailPath = (embedId: string) => `/embeds/${embedId}/thumbnail`;

/** The embeds of a message as its JSON shows them, in text order (one extra query for a whole page). */
export const embedSelect = {
  orderBy: { position: "asc" },
  select: { id: true, url: true, siteName: true, title: true, description: true, thumbHash: true },
} satisfies Prisma.Message$embedsArgs;

type Row = Prisma.MessageEmbedGetPayload<Pick<typeof embedSelect, "select">>;
export const embedDtos = (rows: Row[]) => rows.map(({ id, thumbHash, ...e }) => ({ ...e, thumbnail: thumbHash ? thumbnailPath(id) : null }));
