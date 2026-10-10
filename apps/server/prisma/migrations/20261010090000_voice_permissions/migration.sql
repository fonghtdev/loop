-- New bits CONNECT (256) | SPEAK (512) | VIDEO (1024) for every existing @everyone role (id = guildId).
-- OR-ing means customised @everyone roles gain the bits too; acceptable because the bits are new.
UPDATE "Role" SET "permissions" = "permissions" | 1792 WHERE "id" = "guildId";
