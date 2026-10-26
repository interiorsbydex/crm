/**
 * One-off, safe recalculation of "PP → Onboarding days" for existing leads.
 *
 * The number used to be measured to the lead's last-edited time, which is wrong. It is now measured to the
 * day the lead actually moved to Onboarding (from its stage history). This only touches that one number,
 * only for leads with a completed PP meeting AND a recorded move to Onboarding. It is not a database change.
 *
 * Usage (from the crm folder):
 *   pnpm tsx scripts/recalculate-pp-onboarding-days.ts            # shows what would change, writes nothing
 *   pnpm tsx scripts/recalculate-pp-onboarding-days.ts --apply    # writes the new numbers
 */
import { recalculatePpOnboardingForAll } from '../server/src/lib/milestones.js';
import { prisma } from '../server/src/lib/prisma.js';

async function main() {
  const apply = process.argv.includes('--apply');
  const r = await recalculatePpOnboardingForAll(apply);
  console.log(`Checked ${r.checked} lead(s) at Onboarding or later; ${r.skipped} had no completed PP meeting or no recorded move to Onboarding (left alone).`);
  for (const c of r.changes) console.log(`  ${c.leadId}: ${c.from ?? 'blank'} → ${c.to} day(s)`);
  console.log(apply ? `Updated ${r.changes.length} lead(s).` : `${r.changes.length} lead(s) would change. Nothing was written. Run again with --apply to save.`);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
