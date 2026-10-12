#!/bin/sh
# Apply pending migrations (non-interactive), then start the server. Configuration comes from the container's
# environment (no .env file in production). A failed migration stops the container instead of serving a stale schema.
set -e
node /prisma-cli/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
exec node dist/server.js
