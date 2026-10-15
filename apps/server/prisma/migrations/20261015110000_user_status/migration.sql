-- User-chosen presence; additive (defaulted column), so an older server keeps running.
ALTER TABLE "User" ADD COLUMN "statusPref" TEXT NOT NULL DEFAULT 'online';
ALTER TABLE "User" ADD CONSTRAINT "User_statusPref_check" CHECK ("statusPref" IN ('online', 'idle', 'dnd', 'invisible'));
