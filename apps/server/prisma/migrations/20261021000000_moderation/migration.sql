-- Bans and per-member channel overwrites. Only ADDS two tables, so the previous server still runs on this schema
-- (it ignores both: it neither enforces bans nor applies member overwrites until upgraded). Deleting a Member
-- (leave, kick, ban, also by old code) cascades to its member overwrites.

-- CreateTable
CREATE TABLE "ChannelMemberOverwrite" (
    "guildId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "allow" INTEGER NOT NULL,
    "deny" INTEGER NOT NULL,

    CONSTRAINT "ChannelMemberOverwrite_pkey" PRIMARY KEY ("channelId","userId"),
    CONSTRAINT "ChannelMemberOverwrite_allow_deny_check" CHECK (("allow" & "deny") = 0)
);

-- CreateTable
CREATE TABLE "GuildBan" (
    "guildId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "bannedById" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuildBan_pkey" PRIMARY KEY ("guildId","userId"),
    CONSTRAINT "GuildBan_reason_check" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 200)
);

-- CreateIndex
CREATE INDEX "ChannelMemberOverwrite_guildId_userId_idx" ON "ChannelMemberOverwrite"("guildId", "userId");

-- CreateIndex
CREATE INDEX "GuildBan_userId_idx" ON "GuildBan"("userId");

-- AddForeignKey
ALTER TABLE "ChannelMemberOverwrite" ADD CONSTRAINT "ChannelMemberOverwrite_guildId_channelId_fkey" FOREIGN KEY ("guildId", "channelId") REFERENCES "Channel"("guildId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMemberOverwrite" ADD CONSTRAINT "ChannelMemberOverwrite_guildId_userId_fkey" FOREIGN KEY ("guildId", "userId") REFERENCES "Member"("guildId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildBan" ADD CONSTRAINT "GuildBan_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildBan" ADD CONSTRAINT "GuildBan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildBan" ADD CONSTRAINT "GuildBan_bannedById_fkey" FOREIGN KEY ("bannedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
