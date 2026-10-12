#!/usr/bin/env bash
# Dumps the Postgres database to deploy/backups/loop-<timestamp>.sql.gz and keeps the newest KEEP (default 14).
# Run from anywhere:  ./deploy/backup.sh   (cron example: 15 3 * * * /home/ubuntu/loop/deploy/backup.sh)
# Files in R2 are NOT included (R2 stores them durably; back the bucket up separately if they matter).
set -euo pipefail
cd "$(dirname "$0")"
KEEP="${KEEP:-14}"
mkdir -p backups
file="backups/loop-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
# --clean --if-exists: the dump can be loaded over an existing database.
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U loop -d loop --clean --if-exists --no-owner | gzip > "$file.tmp"
mv "$file.tmp" "$file"
ls -1t backups/loop-*.sql.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "Backup written: $PWD/$file ($(du -h "$file" | cut -f1))"
echo "Restore (stops the server first, then loads it):"
echo "  cd $PWD && docker compose -f docker-compose.prod.yml stop server && gunzip -c $file | docker compose -f docker-compose.prod.yml exec -T postgres psql -U loop -d loop && docker compose -f docker-compose.prod.yml start server"
