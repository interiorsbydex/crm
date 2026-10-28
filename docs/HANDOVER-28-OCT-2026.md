# Handover (28 Oct 2026) — for the session that continues this work

Owner: Pranesh (product manager, not a developer: talk plain English, no jargon). Client: Interiors by DeX
(Annie = Branch Head). Branch: `feature/flexibility-batch3` on github.com/interiorsbydex/crm. Commit as
`Pranesh <denstudioindia@gmail.com>`; never use another GitHub account; never put keys/passwords in the repo.

## What was built (all on the branch, 384 server tests, client type-check clean apart from old known errors)
Admin screens so Annie can configure the CRM herself (stage names/rules, document types, CRM settings, automations,
dashboards, permissions, checklists, reports & NPS, lead routing & access, meetings, in-app alerts, formulas,
wording, custom dashboard boxes, checklist documents) + the 7 agreed features (duplicate leads, On Hold reminder,
list sorting, PP→Onboarding days, SLA breach email with a link to the lead, lead-history entries, report filters/CSV),
mail attachments, a Google Form webhook secret, plus bug fixes found in testing (dashboard double counting under
team visibility, duplicate names refused, designer ageing after direct assignment, etc.).
See `server/src/lib/*Settings*.ts`, `versionedConfig.ts`, `client/src/components/admin/`.

## Where things stand
- Replit DEV copy (workspace, dev DB `heliumdb`) was updated to our branch (Replit commit "Update dev to a316137 …").
  Replit's remote is now ONLY github.com/interiorsbydex/crm (git-pranesh was removed). Histories are unrelated: update
  Replit by `git fetch origin && git checkout origin/feature/flexibility-batch3 -- .` then commit; never `git merge/pull/reset`.
- LIVE (fyx.interiorsbydex.com) was published by Pranesh himself ~28 Oct 14:20 UTC. The new routes answer there
  (`/api/custom-boxes` 401, `/api/email/extras/x` 401). NOT yet verified: whether the live database has the six additive
  changes (below). Do this first.
- Database: six additive, repeat-safe changes (`prisma/migrations/20261025120000..150000`) are applied by the server
  itself at start-up (`server/src/lib/ensureSchema.ts`, commit a316137; `ENSURE_SCHEMA=off` skips). If the published
  version is older than a316137 the live DB may lack them: then run the SQL in `REPLIT-DEPLOY.md` step 1 on the live
  DB (Replit → Database → Production → SQL console, "Enable Editing"; point-in-time recovery 7 days + backups 28 days are on).
  Check: live logs should show `[schema] additive changes checked: 6 ok`, or SELECT from information_schema for
  `lead_files.customType`, `*_checklists.customValues`, `notification_logs.muted`, table `email_drafts`.
- Live logs show repeated BullMQ/Redis errors ("Stream isn't writeable and enableOfflineQueue options is false"):
  the background job worker may not be running in production. SLA breach emails, On Hold reminders and the midnight
  job depend on it. Probably older than this work (Replit's own history has a "Fix BullMQ/ioredis job worker losing
  Redis connection" commit) but worth checking.
- Replit's own AI agent is waiting on a question ("Confirm the nine CRM corrections…"). Do not answer it and NEVER type
  commands into Replit's chat box (it starts an AI run). Use the Shell tab only.

## Results of the Replit dev test (28 Oct): see Pranesh's local `TEST-REPORT-REPLIT.md`
Core lead journey, ~20 of 24 customisations on screen, every client email (real delivery to Pranesh's own mailbox),
attachments, targets, medals, On Hold reminder, SLA email, duplicates and Annie's 9 reported issues all passed.
Not proven on Replit by choice: automatic lead routing (it would notify real Business Leads), adding a brand-new
document type, SMS/WhatsApp/ads (the agency's job). Meeting star ratings only proven on the local copy.

## Safety lessons (read before touching dev data)
Dev data is a copy of live: real staff (e.g. 14 Business Leads, Branch Heads) and real client details; email is really
connected (Resend). Several actions notify EVERY active Business Lead and Branch Head, in-app and by email unless the
Admin → Automations switch is off: placing On Hold, marking Inactive/Reactivated, unanswered-call escalation, meeting
no-show, discount requests. Two real accounts were alerted by test leads on dev. Do not repeat that; Annie can switch
those emails/alerts off in Admin → Automations / In-app Alerts. Dev and live share one Supabase login project: never
create accounts or reset passwords. The sign-in passwords for dev test users were typed by Pranesh only.

## Open items / decisions
1. Verify the live DB columns and that live works (sign in as Branch Head: Leads, a lead's checklists, notifications).
2. Whether alerts should reach only a lead's own team (today: every BL and Branch Head). Pranesh: leave it to Annie's
   Admin switches. A per-team scope would be new work.
3. Final handover: the sheet "What Annie controls" (local, in Pranesh's folder) lists what Annie controls and what needs us.
4. Automated tests that share the settings table can fail randomly when run in parallel (not a real failure; rerun).
Run tests: `cd server && DATABASE_URL=postgresql://postgres@localhost:<port>/<test db> npx vitest run` (own test DB, never live).
