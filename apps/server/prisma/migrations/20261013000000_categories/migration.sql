-- Channel categories. Additive only (new table, new nullable column): the previous server version keeps working
-- against this schema while it is still deployed.
-- Requires PostgreSQL 15+ (column list in ON DELETE SET NULL).

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "guildId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN "categoryId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "Category_guildId_name_key" ON "Category"("guildId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_guildId_id_key" ON "Category"("guildId", "id");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: composite so a channel can only point at a category of its own guild. A plain SET NULL would also
-- null the NOT NULL guildId, so the column list restricts it to categoryId (Prisma cannot express this).
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_guildId_categoryId_fkey" FOREIGN KEY ("guildId", "categoryId") REFERENCES "Category"("guildId", "id") ON DELETE SET NULL ("categoryId") ON UPDATE CASCADE;

-- Backfill: every existing guild gets the two default categories, channels move into the one matching their type
-- (position renumbered 0..n inside the category by old position, then createdAt). Prisma runs the file in one transaction.
INSERT INTO "Category" ("id", "guildId", "name", "position")
SELECT gen_random_uuid(), g."id", c."name", c."position"
FROM "Guild" g
CROSS JOIN (VALUES ('Kênh văn bản', 0), ('Kênh thoại', 1)) AS c("name", "position")
ON CONFLICT ("guildId", "name") DO NOTHING;

UPDATE "Channel" ch
SET "categoryId" = r."categoryId", "position" = r."newPosition"
FROM (
    SELECT ch2."id",
           cat."id" AS "categoryId",
           (row_number() OVER (PARTITION BY ch2."guildId", ch2."type" ORDER BY ch2."position", ch2."createdAt", ch2."id") - 1)::int AS "newPosition"
    FROM "Channel" ch2
    JOIN "Category" cat ON cat."guildId" = ch2."guildId"
        AND cat."name" = CASE ch2."type" WHEN 'TEXT' THEN 'Kênh văn bản' ELSE 'Kênh thoại' END
    WHERE ch2."categoryId" IS NULL
) r
WHERE ch."id" = r."id";
