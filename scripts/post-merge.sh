#!/bin/bash
set -e
pnpm install --frozen-lockfile
# No automatic database push here. The CRM's tables are defined in
# prisma/schema.prisma; lib/db is an empty Drizzle template, and pushing it
# would try to remove every CRM table. Database changes are applied by hand
# from prisma/migrations (each one is additive and safe to re-run).
