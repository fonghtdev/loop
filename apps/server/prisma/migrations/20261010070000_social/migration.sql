-- CreateEnum
CREATE TYPE "FriendStatus" AS ENUM ('PENDING', 'ACCEPTED');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "dmChannelId" UUID,
ALTER COLUMN "channelId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Friendship" (
    "userLowId" UUID NOT NULL,
    "userHighId" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "status" "FriendStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("userLowId","userHighId")
);

-- CreateTable
CREATE TABLE "Block" (
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "DmChannel" (
    "id" UUID NOT NULL,
    "userLowId" UUID NOT NULL,
    "userHighId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3),

    CONSTRAINT "DmChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Friendship_userHighId_idx" ON "Friendship"("userHighId");

-- CreateIndex
CREATE INDEX "Block_blockedId_idx" ON "Block"("blockedId");

-- CreateIndex
CREATE INDEX "DmChannel_userHighId_idx" ON "DmChannel"("userHighId");

-- CreateIndex
CREATE UNIQUE INDEX "DmChannel_userLowId_userHighId_key" ON "DmChannel"("userLowId", "userHighId");

-- CreateIndex
CREATE INDEX "Message_dmChannelId_seq_idx" ON "Message"("dmChannelId", "seq");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DmChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_userLowId_fkey" FOREIGN KEY ("userLowId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_userHighId_fkey" FOREIGN KEY ("userHighId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmChannel" ADD CONSTRAINT "DmChannel_userLowId_fkey" FOREIGN KEY ("userLowId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmChannel" ADD CONSTRAINT "DmChannel_userHighId_fkey" FOREIGN KEY ("userHighId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written constraints (Prisma cannot express CHECKs).
-- A message belongs to exactly one of a guild channel or a DM channel.
ALTER TABLE "Message" ADD CONSTRAINT "Message_one_target_check" CHECK (("channelId" IS NULL) <> ("dmChannelId" IS NULL));

-- Unordered pairs are stored low < high: one row per pair, no self pairs.
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_pair_order_check" CHECK ("userLowId" < "userHighId");
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_requester_check" CHECK ("requesterId" IN ("userLowId", "userHighId"));
ALTER TABLE "DmChannel" ADD CONSTRAINT "DmChannel_pair_order_check" CHECK ("userLowId" < "userHighId");
ALTER TABLE "Block" ADD CONSTRAINT "Block_not_self_check" CHECK ("blockerId" <> "blockedId");
