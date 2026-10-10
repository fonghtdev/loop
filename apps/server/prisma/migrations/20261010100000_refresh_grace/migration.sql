-- Rotation chain for the refresh grace window. Nullable: sessions rotated before this migration have no
-- rotatedAt, so a reuse of their token is still treated as theft (no grace).
ALTER TABLE "Session" ADD COLUMN "rotatedAt" TIMESTAMP(3),
ADD COLUMN "successorId" UUID;

CREATE UNIQUE INDEX "Session_successorId_key" ON "Session"("successorId");

ALTER TABLE "Session" ADD CONSTRAINT "Session_successorId_fkey" FOREIGN KEY ("successorId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
