-- Task #87 — project team-member assignment (BL approval) + PD/DTL admin fields
-- Note: applied narrowly via raw SQL against the live DB and recorded here with
-- `prisma migrate resolve --applied` (see .agents/memory/prisma-schema-drift.md
-- for why a plain `prisma db push`/`migrate dev` is unsafe in this environment —
-- unrelated pre-existing drift in `discount_requests`/`nps_responses` blocks it).

DO $$ BEGIN
  CREATE TYPE "TeamMemberStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "pdUserId" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "dtlUserId" TEXT;

DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_pdUserId_fkey" FOREIGN KEY ("pdUserId") REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_dtlUserId_fkey" FOREIGN KEY ("dtlUserId") REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "project_team_members" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "status" "TeamMemberStatus" NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_team_members_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "project_team_members_projectId_idx" ON "project_team_members"("projectId");
CREATE INDEX IF NOT EXISTS "project_team_members_userId_idx" ON "project_team_members"("userId");

DO $$ BEGIN
  ALTER TABLE "project_team_members" ADD CONSTRAINT "project_team_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "project_team_members" ADD CONSTRAINT "project_team_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "project_team_members" ADD CONSTRAINT "project_team_members_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "project_team_members" ADD CONSTRAINT "project_team_members_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
