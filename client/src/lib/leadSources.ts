// Shared lead-source options (task #90 added AFFILIATE_MARKETING). Source is
// a free-form string column server-side (no Prisma enum), so this list is
// purely a client-side convenience for the New Lead form and filters.
export const SOURCE_OPTIONS = [
  'META_ADS',
  'GOOGLE_ADS',
  'REFERRAL',
  'WALK_IN',
  'ORGANIC',
  'AFFILIATE_MARKETING',
  'OTHER',
];
