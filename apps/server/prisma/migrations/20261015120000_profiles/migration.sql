-- Profiles, server identity and image uploads. Additive only (nullable columns + one new table), so an older
-- server keeps running on this schema. Lengths count characters (code points), like the zod schemas.
ALTER TABLE "User"
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "bio" TEXT,
  ADD COLUMN "statusText" TEXT,
  ADD COLUMN "avatarHash" TEXT,
  ADD COLUMN "bannerHash" TEXT;
ALTER TABLE "User" ADD CONSTRAINT "User_displayName_check" CHECK ("displayName" IS NULL OR char_length("displayName") BETWEEN 1 AND 32);
ALTER TABLE "User" ADD CONSTRAINT "User_bio_check" CHECK ("bio" IS NULL OR char_length("bio") <= 190);
ALTER TABLE "User" ADD CONSTRAINT "User_statusText_check" CHECK ("statusText" IS NULL OR char_length("statusText") <= 128);

ALTER TABLE "Guild" ADD COLUMN "iconHash" TEXT;

ALTER TABLE "Channel" ADD COLUMN "topic" TEXT;
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_topic_check" CHECK ("topic" IS NULL OR char_length("topic") <= 1024);

CREATE TABLE "ProfileUpload" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "guildId" UUID,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileUpload_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProfileUpload_kind_check" CHECK ("kind" IN ('avatar', 'banner', 'icon')),
    CONSTRAINT "ProfileUpload_target_check" CHECK (("kind" = 'icon') = ("guildId" IS NOT NULL))
);

CREATE INDEX "ProfileUpload_userId_idx" ON "ProfileUpload"("userId");
CREATE INDEX "ProfileUpload_createdAt_idx" ON "ProfileUpload"("createdAt");

ALTER TABLE "ProfileUpload" ADD CONSTRAINT "ProfileUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProfileUpload" ADD CONSTRAINT "ProfileUpload_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
