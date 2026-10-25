# FYX CRM

Application source for the Interiors by DeX CRM.

## Repository contents

- `client/`: CRM web interface.
- `server/`: CRM API, background jobs and application services.
- `prisma/`: database schema, migrations and environment-configured seed script.
- `artifacts/`, `lib/` and `scripts/`: workspace services, shared packages and tooling.
- `reporting/`: reporting SQL definitions, not database contents.

This is a clean source snapshot. The original private Git history, customer
uploads, client documents, recordings, screenshots, database backups, internal
notes and deployment credentials are intentionally excluded.

## Local development

Use Node.js 24 and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm exec prisma generate --schema prisma/schema.prisma
```

Configure your own environment using `.env.example` as a starting point.
Additional integrations can require environment variables referenced by their
server modules. Use your own development database and service accounts; this
repository does not include production access or customer data.

Start the API and web interface in separate terminals:

```sh
pnpm --filter @workspace/crm-server run dev
pnpm --filter @workspace/crm-client run dev
```

The application also includes Replit artifact configuration. The
instance-specific root `.replit` configuration is intentionally excluded.
Configure environment variables and secrets in the destination environment
before running or publishing it.

## Database safety

Review schema changes before applying them. Existing environments may have
schema drift, so do not run migrations or schema-push commands against an
existing production database without a reviewed migration plan.

Seeding requires explicitly supplied `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD`; no administrator credentials are included.
