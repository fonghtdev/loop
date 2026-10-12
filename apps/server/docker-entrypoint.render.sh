#!/bin/sh
# Render free web service: Redis runs inside this container (loopback only, random password, nothing persisted),
# Postgres is external. PID 1 is tini -g (see Dockerfile), which forwards SIGTERM to redis and node alike.
# Migrations use DIRECT_URL when set (a pooled/pgbouncer URL cannot run `migrate deploy`), else DATABASE_URL.
set -e
REDIS_PASSWORD=$(openssl rand -hex 24)
redis-server --bind 127.0.0.1 --port 6379 --requirepass "$REDIS_PASSWORD" --save "" --appendonly no \
  --maxmemory 64mb --maxmemory-policy allkeys-lru --daemonize no >/dev/null &
export REDISCLI_AUTH="$REDIS_PASSWORD"
for _ in $(seq 1 50); do redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG && break; sleep 0.1; done
redis-cli -h 127.0.0.1 ping | grep -q PONG || { echo "redis did not start" >&2; exit 1; }
export REDIS_URL="redis://:$REDIS_PASSWORD@127.0.0.1:6379"
DATABASE_URL="${DIRECT_URL:-$DATABASE_URL}" node /prisma-cli/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
exec node dist/server.js
