-- Threads. A thread is a Channel row of type THREAD under a TEXT channel of the same guild (its parent), so its
-- messages, attachments, read state, reactions and pins use the existing channel-keyed tables unchanged and cascade
-- with it. A thread has no overwrites of its own: the server resolves its permissions from the parent.
-- Additive for an older server: every new column is nullable or has a default, and channel names stay unique among
-- non-thread channels (a partial index raises the same unique violation an older server already maps to 409).
-- Note: an older server's Prisma client does not know the THREAD value, so once a thread exists it fails (500,
-- never a leak) on queries that read that guild's channel rows; it runs fine until the first thread is created.
ALTER TYPE "ChannelType" ADD VALUE 'THREAD';

ALTER TABLE "Channel"
    ADD COLUMN "parentChannelId" UUID,
    ADD COLUMN "starterMessageId" UUID,
    ADD COLUMN "createdById" UUID,
    ADD COLUMN "lastMessageAt" TIMESTAMP(3),
    ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- A thread (and only a thread) has a parent; the thread-only fields stay empty on other channels. The enum is
-- compared as text: the value added above cannot be referenced in the same transaction.
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_thread_shape_check" CHECK (
    ("parentChannelId" IS NOT NULL) = ("type"::text = 'THREAD')
    AND ("parentChannelId" IS NOT NULL OR ("starterMessageId" IS NULL AND "createdById" IS NULL AND "archived" = false))
);
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_thread_name_check" CHECK ("parentChannelId" IS NULL OR char_length("name") BETWEEN 1 AND 100);

-- Same-guild parent (composite like the other in-guild FKs); deleting the parent deletes its threads (and so their messages).
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_guildId_parentChannelId_fkey" FOREIGN KEY ("guildId", "parentChannelId") REFERENCES "Channel"("guildId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Channel_parentChannelId_idx" ON "Channel"("parentChannelId");

-- One thread per starter message. Not a foreign key: the starter may be deleted and the thread stays.
CREATE UNIQUE INDEX "Channel_starterMessageId_key" ON "Channel"("starterMessageId");

-- Thread names are free text and may repeat; channel names stay unique per guild.
DROP INDEX "Channel_guildId_name_key";
CREATE UNIQUE INDEX "Channel_guildId_name_key" ON "Channel"("guildId", "name") WHERE "parentChannelId" IS NULL;
