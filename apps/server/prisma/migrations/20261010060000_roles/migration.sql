-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "guildId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberRole" (
    "guildId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,

    CONSTRAINT "MemberRole_pkey" PRIMARY KEY ("guildId","userId","roleId")
);

-- CreateTable
CREATE TABLE "ChannelOverwrite" (
    "guildId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "allow" INTEGER NOT NULL,
    "deny" INTEGER NOT NULL,

    CONSTRAINT "ChannelOverwrite_pkey" PRIMARY KEY ("channelId","roleId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_guildId_id_key" ON "Role"("guildId", "id");

-- CreateIndex
CREATE INDEX "MemberRole_roleId_idx" ON "MemberRole"("roleId");

-- CreateIndex
CREATE INDEX "ChannelOverwrite_roleId_idx" ON "ChannelOverwrite"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_guildId_id_key" ON "Channel"("guildId", "id");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberRole" ADD CONSTRAINT "MemberRole_guildId_userId_fkey" FOREIGN KEY ("guildId", "userId") REFERENCES "Member"("guildId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberRole" ADD CONSTRAINT "MemberRole_guildId_roleId_fkey" FOREIGN KEY ("guildId", "roleId") REFERENCES "Role"("guildId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelOverwrite" ADD CONSTRAINT "ChannelOverwrite_guildId_channelId_fkey" FOREIGN KEY ("guildId", "channelId") REFERENCES "Channel"("guildId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelOverwrite" ADD CONSTRAINT "ChannelOverwrite_guildId_roleId_fkey" FOREIGN KEY ("guildId", "roleId") REFERENCES "Role"("guildId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- @everyone is the role whose id is its guild's id, and it alone sits at position 0.
ALTER TABLE "Role" ADD CONSTRAINT "Role_everyone_position_check" CHECK (("id" = "guildId") = ("position" = 0));

-- @everyone is implicit, never assigned.
ALTER TABLE "MemberRole" ADD CONSTRAINT "MemberRole_not_everyone_check" CHECK ("roleId" <> "guildId");

-- Backfill: every existing guild gets its @everyone role (19 = VIEW_CHANNEL | SEND_MESSAGES | CREATE_INVITE, DEFAULT_EVERYONE_PERMISSIONS in @loop/shared).
INSERT INTO "Role" ("id", "guildId", "name", "permissions", "position") SELECT "id", "id", '@everyone', 19, 0 FROM "Guild" ON CONFLICT DO NOTHING;
