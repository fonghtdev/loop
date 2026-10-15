-- Optional role color "#RRGGBB"; additive, so an older server keeps running.
ALTER TABLE "Role" ADD COLUMN "color" TEXT;
ALTER TABLE "Role" ADD CONSTRAINT "Role_color_check" CHECK ("color" IS NULL OR "color" ~ '^#[0-9A-Fa-f]{6}$');
