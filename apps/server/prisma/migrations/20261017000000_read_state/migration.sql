-- Server-side read state: how far each user has read each conversation. Additive (one new table), so an older
-- server keeps running on this schema. Exactly one of "channelId" / "dmChannelId" is set (CHECK); each pair has
-- its own partial unique index, which is what the upsert in messages/read-state.ts conflicts on. Unread and
-- mention counts are computed from Message / MessageMention at read time, so there is no counter to drift.
CREATE TABLE "ReadState" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "channelId" UUID,
    "dmChannelId" UUID,
    "lastReadSeq" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReadState_one_conversation" CHECK (("channelId" IS NULL) <> ("dmChannelId" IS NULL))
);
CREATE UNIQUE INDEX "ReadState_userId_channelId_key" ON "ReadState"("userId", "channelId") WHERE "channelId" IS NOT NULL;
CREATE UNIQUE INDEX "ReadState_userId_dmChannelId_key" ON "ReadState"("userId", "dmChannelId") WHERE "dmChannelId" IS NOT NULL;
CREATE INDEX "ReadState_channelId_idx" ON "ReadState"("channelId");
CREATE INDEX "ReadState_dmChannelId_idx" ON "ReadState"("dmChannelId");

ALTER TABLE "ReadState" ADD CONSTRAINT "ReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReadState" ADD CONSTRAINT "ReadState_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReadState" ADD CONSTRAINT "ReadState_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DmChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
