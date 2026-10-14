-- New bit STREAM (2048) for every existing @everyone role (id = guildId); same OR-ing as voice_permissions.
UPDATE "Role" SET "permissions" = "permissions" | 2048 WHERE "id" = "guildId";
