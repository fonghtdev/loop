-- Mentions and pins. Additive only (nullable / defaulted columns + one new table), so an older server keeps
-- running on this schema. "pinnedById" is deliberately not a foreign key, like "replyToId".
ALTER TABLE "Message" ADD COLUMN "mentionEveryone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Message" ADD COLUMN "pinnedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "pinnedById" UUID;
CREATE INDEX "Message_channelId_pinnedAt_idx" ON "Message"("channelId", "pinnedAt");
CREATE INDEX "Message_dmChannelId_pinnedAt_idx" ON "Message"("dmChannelId", "pinnedAt");

CREATE TABLE "MessageMention" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "MessageMention_pkey" PRIMARY KEY ("messageId", "userId")
);
CREATE INDEX "MessageMention_userId_idx" ON "MessageMention"("userId");

ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
