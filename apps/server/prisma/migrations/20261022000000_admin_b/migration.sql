-- Server administration B: audit log, AutoMod keyword rules, server mute / deafen. Only ADDS three tables, so the
-- previous server still runs on this schema (it writes no audit entries, enforces no AutoMod rule and ignores voice
-- moderation until upgraded). The new permission bits (VIEW_AUDIT_LOG 1<<15, MUTE_MEMBERS 1<<16, DEAFEN_MEMBERS
-- 1<<17) are not in @everyone, so no permission backfill. Deleting a Member (leave, kick, ban) cascades to its
-- VoiceModState; deleting a Guild cascades to its log and rules; a deleted account leaves its entries (SET NULL).

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "guildId" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "targetUserId" UUID,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditLog_action_check" CHECK (char_length("action") BETWEEN 1 AND 40),
    CONSTRAINT "AuditLog_targetId_check" CHECK ("targetId" IS NULL OR char_length("targetId") <= 64),
    -- the server keeps meta under 1 KB of compact JSON; this backstop leaves room for jsonb's spaced text form
    CONSTRAINT "AuditLog_metadata_check" CHECK (jsonb_typeof("metadata") = 'object' AND octet_length("metadata"::text) <= 2048)
);

-- CreateTable
CREATE TABLE "AutoModRule" (
    "id" UUID NOT NULL,
    "guildId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "keywords" TEXT[],
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoModRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AutoModRule_name_check" CHECK (char_length("name") BETWEEN 1 AND 60),
    CONSTRAINT "AutoModRule_keywords_check" CHECK ("keywords" IS NOT NULL AND cardinality("keywords") BETWEEN 1 AND 100)
);

-- CreateTable
CREATE TABLE "VoiceModState" (
    "guildId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "serverMute" BOOLEAN NOT NULL DEFAULT false,
    "serverDeafen" BOOLEAN NOT NULL DEFAULT false,
    "setById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceModState_pkey" PRIMARY KEY ("guildId","userId"),
    CONSTRAINT "VoiceModState_some_check" CHECK ("serverMute" OR "serverDeafen") -- "neither" is no row
);

-- CreateIndex
CREATE INDEX "AuditLog_guildId_createdAt_id_idx" ON "AuditLog"("guildId", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AutoModRule_guildId_idx" ON "AutoModRule"("guildId");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoModRule" ADD CONSTRAINT "AutoModRule_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoModRule" ADD CONSTRAINT "AutoModRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceModState" ADD CONSTRAINT "VoiceModState_guildId_userId_fkey" FOREIGN KEY ("guildId", "userId") REFERENCES "Member"("guildId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceModState" ADD CONSTRAINT "VoiceModState_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

