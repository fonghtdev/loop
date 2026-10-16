-- Group DMs on the same conversation id space as pair DMs. Additive for an older server: new columns have
-- defaults or are nullable, existing rows stay PAIR with both pair columns set, and a trigger keeps the new
-- DmParticipant table filled for every PAIR row (including ones an older server inserts), so membership of both
-- kinds can be read from one table.
CREATE TYPE "DmKind" AS ENUM ('PAIR', 'GROUP');

ALTER TABLE "DmChannel"
    ADD COLUMN "kind" "DmKind" NOT NULL DEFAULT 'PAIR',
    ADD COLUMN "ownerId" UUID,
    ADD COLUMN "name" TEXT,
    ADD COLUMN "iconHash" TEXT,
    ALTER COLUMN "userLowId" DROP NOT NULL,
    ALTER COLUMN "userHighId" DROP NOT NULL;

-- A PAIR has both ends (the old "pair_order" CHECK still orders them); a GROUP has neither, so the pair unique
-- index (NULLs are distinct) never ties groups together. Only groups carry a name / owner / icon.
ALTER TABLE "DmChannel" ADD CONSTRAINT "DmChannel_kind_shape_check" CHECK (
    ("kind" = 'PAIR' AND "userLowId" IS NOT NULL AND "userHighId" IS NOT NULL AND "ownerId" IS NULL AND "name" IS NULL AND "iconHash" IS NULL)
    OR ("kind" = 'GROUP' AND "userLowId" IS NULL AND "userHighId" IS NULL)
);
ALTER TABLE "DmChannel" ADD CONSTRAINT "DmChannel_name_check" CHECK ("name" IS NULL OR char_length("name") BETWEEN 1 AND 100);
ALTER TABLE "DmChannel" ADD CONSTRAINT "DmChannel_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "DmParticipant" (
    "dmChannelId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmParticipant_pkey" PRIMARY KEY ("dmChannelId", "userId")
);
CREATE INDEX "DmParticipant_userId_idx" ON "DmParticipant"("userId");
ALTER TABLE "DmParticipant" ADD CONSTRAINT "DmParticipant_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DmChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DmParticipant" ADD CONSTRAINT "DmParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: both people of every existing pair, joined when the pair was created.
INSERT INTO "DmParticipant" ("dmChannelId", "userId", "joinedAt")
SELECT d."id", u."id", d."createdAt"
FROM "DmChannel" d CROSS JOIN LATERAL (VALUES (d."userLowId"), (d."userHighId")) AS u("id")
WHERE d."kind" = 'PAIR'
ON CONFLICT DO NOTHING;

-- Every PAIR insert gets its two participants in the same statement (old and new server code alike).
CREATE FUNCTION "DmChannel_pair_participants"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "DmParticipant" ("dmChannelId", "userId", "joinedAt")
    VALUES (NEW."id", NEW."userLowId", NEW."createdAt"), (NEW."id", NEW."userHighId", NEW."createdAt")
    ON CONFLICT DO NOTHING;
    RETURN NULL;
END $$;
CREATE TRIGGER "DmChannel_pair_participants" AFTER INSERT ON "DmChannel"
    FOR EACH ROW WHEN (NEW."kind" = 'PAIR') EXECUTE FUNCTION "DmChannel_pair_participants"();
