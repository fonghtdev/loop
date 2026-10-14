-- Bot accounts: additive only (new nullable/defaulted columns), so an older server keeps running.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "botTokenHash" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerId" UUID;

-- A bot always has an owner and only bots have one; only bots carry a bot token.
ALTER TABLE "User" ADD CONSTRAINT "User_bot_owner_check" CHECK ("isBot" = ("ownerId" IS NOT NULL));
ALTER TABLE "User" ADD CONSTRAINT "User_bot_token_check" CHECK ("botTokenHash" IS NULL OR "isBot");

-- CreateIndex
CREATE UNIQUE INDEX "User_botTokenHash_key" ON "User"("botTokenHash");

-- CreateIndex
CREATE INDEX "User_ownerId_idx" ON "User"("ownerId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
