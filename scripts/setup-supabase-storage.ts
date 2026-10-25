/**
 * One-time, idempotent Supabase Storage setup for floor-plan / lead-file uploads.
 *
 * Creates the two buckets this CRM depends on if they don't already exist:
 *  - crm-files       (public)  — legacy floor-plan uploads (POST /api/leads/:id/floor-plan)
 *  - crm-lead-files  (private) — general lead file attachments (POST /api/leads/:id/files),
 *                                 served via short-lived signed URLs
 *
 * Safe to re-run: it checks for existing buckets first instead of blindly calling
 * createBucket (which 400s if a bucket already exists with different settings).
 *
 * Usage: pnpm tsx scripts/setup-supabase-storage.ts
 */
import { supabaseAdmin } from '../server/src/lib/supabase.js';

async function main() {
  if (!supabaseAdmin) {
    console.error(
      '❌ SUPABASE_SERVICE_ROLE_KEY (and/or SUPABASE_URL) is not configured — cannot manage storage buckets.',
    );
    process.exit(1);
  }

  const { data: existing, error: listError } = await supabaseAdmin.storage.listBuckets();
  if (listError) {
    console.error(`❌ Could not reach Supabase Storage: ${listError.message}`);
    process.exit(1);
  }
  const existingNames = new Set((existing ?? []).map((b) => b.name));

  const wanted: { name: string; public: boolean }[] = [
    { name: 'crm-files', public: true },
    { name: 'crm-lead-files', public: false },
  ];

  for (const bucket of wanted) {
    if (existingNames.has(bucket.name)) {
      const found = existing!.find((b) => b.name === bucket.name)!;
      if (found.public !== bucket.public) {
        console.warn(
          `⚠ Bucket "${bucket.name}" already exists but public=${found.public}, expected ${bucket.public}. ` +
          `Update it manually in the Supabase dashboard (Storage → ${bucket.name} → Edit bucket) if uploads/downloads misbehave.`,
        );
      } else {
        console.log(`✓ Bucket "${bucket.name}" already exists (public=${found.public}) — nothing to do.`);
      }
      continue;
    }
    const { error } = await supabaseAdmin.storage.createBucket(bucket.name, { public: bucket.public });
    if (error) {
      console.error(`❌ Failed to create bucket "${bucket.name}": ${error.message}`);
      process.exit(1);
    }
    console.log(`✓ Created bucket "${bucket.name}" (public=${bucket.public}).`);
  }

  console.log(
    '\nNote: Supabase\'s hosted Storage API is CORS-open by default for browser uploads; ' +
    'no separate CORS configuration is needed. Row-level security on storage.objects is only ' +
    'relevant if you later restrict access with custom policies — the server always uses the ' +
    'service-role key, which bypasses RLS.',
  );
}

main();
