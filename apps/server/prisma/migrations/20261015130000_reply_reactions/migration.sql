-- Replies and reactions. Additive only (one nullable column + one new table), so an older server keeps running
-- on this schema. "replyToId" is deliberately not a foreign key: when the replied-to message is deleted the id
-- stays, and the API reports the reply target as deleted.
ALTER TABLE "Message" ADD COLUMN "replyToId" UUID;
CREATE INDEX "Message_replyToId_idx" ON "Message"("replyToId");

CREATE TABLE "Reaction" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reaction_pkey" PRIMARY KEY ("messageId", "userId", "emoji"),
    CONSTRAINT "Reaction_emoji_check" CHECK (char_length("emoji") BETWEEN 1 AND 32)
);

ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
