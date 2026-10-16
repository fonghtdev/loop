-- Link previews. Additive only (one new table), so an older server keeps running on this schema: it never reads
-- the table, and deleting a message still cascades to its previews in the database.
CREATE TABLE "MessageEmbed" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "finalUrl" TEXT,
    "siteName" TEXT,
    "title" TEXT,
    "description" TEXT,
    "thumbHash" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageEmbed_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MessageEmbed_url_check" CHECK (char_length("url") BETWEEN 1 AND 2048),
    CONSTRAINT "MessageEmbed_finalUrl_check" CHECK (char_length("finalUrl") <= 4096),
    CONSTRAINT "MessageEmbed_siteName_check" CHECK (char_length("siteName") <= 60),
    CONSTRAINT "MessageEmbed_title_check" CHECK (char_length("title") <= 150),
    CONSTRAINT "MessageEmbed_description_check" CHECK (char_length("description") <= 300),
    CONSTRAINT "MessageEmbed_thumbHash_check" CHECK ("thumbHash" ~ '^[0-9a-f]{32}$'),
    CONSTRAINT "MessageEmbed_position_check" CHECK ("position" BETWEEN 0 AND 2)
);

CREATE UNIQUE INDEX "MessageEmbed_messageId_url_key" ON "MessageEmbed"("messageId", "url");

ALTER TABLE "MessageEmbed" ADD CONSTRAINT "MessageEmbed_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
