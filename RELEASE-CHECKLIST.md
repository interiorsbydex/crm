# Release checklist

Run this on the **Replit test copy (dev)** before every publish. Use test
leads and test logins only. If any step fails, do not publish.

## 1. Automatic checks (5 minutes)

- Server tests: `cd server && npx vitest run` — every test must pass.
- Client build: `cd client && npx vite build` — must finish without errors.
- New database changes in `prisma/migrations` since the last release are run
  by hand on dev first (they are written to be safe to run twice). Never use
  `prisma db push` or `drizzle-kit push`.

## 2. Every page opens (10 minutes)

Sign in as each role — Branch Head, Business Lead, Designer, CRE — and open
every item in the left menu. No page may show an error or stay blank.
As Branch Head, open every Admin tab.

## 3. One lead, start to finish (20 minutes)

1. **CRE** creates a walk-in lead → it lands in MQL and is assigned as set in
   Admin → Lead Routing & Access.
2. **Business Lead** assigns the designer (if routing didn't).
3. **Designer** moves it through DQL → Proposal Ready → Proposal Presented → PD.
   The Proposal Ready email opens for review (unless set to send straight away).
4. **Designer** tries to jump to Onboarding → refused, with a clear list.
5. Upload the required files, fill the PD → OB checklist, send the welcome
   mail → lead moves to Onboarding.
6. Fill the OB → OBM checklist, send the NPS email (the panel must say
   "drafted — not sent yet" before sending, "sent" after), send the OBM mail
   → lead moves to Onboarding Meeting.
7. **Business Lead** completes the DIP checklist; mark the onboarding meeting
   held; move to Design in Progress.
8. Dashboards show the booking and the designer's credits.

## 4. Annie's earlier issues (5 minutes)

These are also covered by automatic tests (`server/src/lib/annieRegressions.test.ts`):
no Booking Forecast tile; Lead Progression shows days in words; designer
ageing counts from assignment; the agreed value is after discount, excluding
GST; DIP wording; welcome documents attached; no repeated NPS prompt; NPS
draft vs sent; onboarding email keeps its date table.

## 5. Clean up

Delete or mark as test any lead created for the check. Put back any Admin
setting you changed (each Admin screen has "Restore original settings" and a
change history).
