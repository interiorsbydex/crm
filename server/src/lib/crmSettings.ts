/**
 * CRM Settings (Admin → CRM Settings): the dropdown lists and simple numbers
 * the client wants to control themselves — cities and areas, lead sources,
 * reason lists, which details a new lead needs, discount approval limits,
 * reminder timing, the weekly digest day, design-phase days and stage names.
 *
 * Saved in AssignmentConfig under CRM_SETTINGS_KEY with a revision number (so
 * two admins can't silently overwrite each other); every save is recorded in
 * the activity log for the change history. With nothing saved, DEFAULT_CRM_SETTINGS
 * applies — the values the CRM shipped with.
 */
import { z } from 'zod';
import { prisma } from './prisma.js';
import { logActivity } from './activityLog.js';

export const CRM_SETTINGS_KEY = 'crm_settings_v1';
export const CRM_SETTINGS_ACTIONS = ['CRM_SETTINGS_UPDATED', 'CRM_SETTINGS_RESET'] as const;

/** Lead details an admin can require when a lead is created (name, phone and source always are). */
export const LEAD_DETAIL_OPTIONS: { field: string; label: string }[] = [
  { field: 'projectType', label: 'Project type' },
  { field: 'scope', label: 'Scope of work' },
  { field: 'location', label: 'Location' },
  { field: 'possessionTimeline', label: 'Possession timeline' },
  { field: 'email', label: 'Email' },
  { field: 'estimatedValue', label: 'Client budget' },
];
const LEAD_DETAIL_FIELDS = LEAD_DETAIL_OPTIONS.map((o) => o.field) as [string, ...string[]];

/** Stages whose names an admin can change. */
export const NAMEABLE_STAGES = [
  'EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION',
  'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER',
] as const;
/** Stages that can be switched off (hidden from stage menus and skipped over). */
export const HIDEABLE_STAGES = ['DQL', 'PROPOSAL_READY', 'PROPOSAL_DISCUSSION'] as const;

export const DESIGN_PHASE_KEYS = [
  'SITE_DOCUMENTATION', 'SITE_DISCUSSION', 'LAYOUT_FINALISATION', 'DESIGN_DISCUSSION',
  'PRE_SIGN_OFF', 'MASKING', 'SIGN_OFF', 'EIP',
] as const;

const CHENNAI_AREAS = [
  'Alwarpet', 'Abiramapuram', 'Teynampet', 'Gopalapuram', 'Royapettah', 'Mylapore',
  'R.A. Puram', 'Nandanam', 'Thousand Lights', 'Nungambakkam', 'Egmore', 'Chetpet',
  'Kilpauk', 'Purasawalkam', 'Choolaimedu', 'Choolai', 'Anna Salai', 'T. Nagar',
  'West Mambalam', 'Saidapet', 'Kodambakkam', 'Ashok Nagar', 'K.K. Nagar',
  'Vadapalani', 'Saligramam', 'Virugambakkam', 'Adyar', 'Besant Nagar',
  'Gandhi Nagar', 'Indira Nagar', 'Kasturba Nagar', 'Thiruvanmiyur', 'Kotturpuram',
  'Kottur', 'Velachery', 'Taramani', 'Perungudi', 'Kandanchavadi', 'Sholinganallur',
  'Karapakkam', 'Thoraipakkam', 'Okkiyam Thoraipakkam', 'Kottivakkam', 'Palavakkam',
  'Neelankarai', 'Injambakkam', 'Uthandi', 'Akkarai', 'Semmenchery', 'Pallikaranai',
  'Medavakkam', 'Madipakkam', 'Keelkattalai', 'Adambakkam', 'Alandur',
  'Guindy', 'Ekkatuthangal', 'Nanganallur', 'Manapakkam', 'Mugalivakkam', 'Porur',
  'Ramapuram', 'Valasaravakkam', 'Maduravoyal', 'Anna Nagar', 'Anna Nagar West',
  'Anna Nagar East', 'Aminjikarai', 'Arumbakkam', 'Mogappair', 'Mogappair East',
  'Mogappair West', 'Nolambur', 'Koyambedu', 'Villivakkam', 'Padi', 'Korattur',
  'Ambattur', 'Pattaravakkam', 'Avadi', 'Thirumullaivoyal', 'Ayappakkam',
  'Perambur', 'Kolathur', 'Ayanavaram', 'Madhavaram', 'Manali', 'Tondiarpet',
  'Royapuram', 'Washermanpet', 'George Town', 'Broadway', 'Basin Bridge',
  'Vyasarpadi', 'Ennore', 'Thiruvottiyur', 'Red Hills', 'Tambaram', 'West Tambaram',
  'East Tambaram', 'Chromepet', 'Pallavaram', 'Pammal', 'Anakaputhur', 'Chitlapakkam',
  'Sembakkam', 'Selaiyur', 'Perungalathur', 'Vandalur', 'Guduvanchery', 'Urapakkam',
  'Kelambakkam',
];

const text = (max: number) => z.string().trim().min(1, 'cannot be empty').max(max, `is limited to ${max} characters`);
const list = (max: number, itemMax = 120) => z.array(text(itemMax)).max(max).superRefine((items, ctx) => {
  const seen = new Set<string>();
  items.forEach((v, i) => {
    if (seen.has(v.toLowerCase())) ctx.addIssue({ code: 'custom', path: [i], message: `"${v}" is listed twice` });
    seen.add(v.toLowerCase());
  });
});

export const crmSettingsSchema = z.object({
  cities: z.array(z.object({ name: text(60), areas: list(400, 80) }).strict()).min(1, 'Keep at least one city').max(100)
    .superRefine((cities, ctx) => {
      const seen = new Set<string>();
      cities.forEach((c, i) => {
        if (seen.has(c.name.toLowerCase())) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `"${c.name}" is listed twice` });
        seen.add(c.name.toLowerCase());
      });
    }),
  leadSources: z.array(z.object({
    value: z.string().regex(/^[A-Z0-9_]{2,40}$/, 'codes use capital letters, numbers and _'),
    label: text(60),
    active: z.boolean(),
  }).strict()).min(1).max(60).superRefine((sources, ctx) => {
    const seen = new Set<string>();
    sources.forEach((s, i) => {
      if (seen.has(s.value)) ctx.addIssue({ code: 'custom', path: [i, 'value'], message: `"${s.value}" is listed twice` });
      seen.add(s.value);
    });
    if (!sources.some((s) => s.value === 'OTHER' && s.active)) ctx.addIssue({ code: 'custom', message: 'Keep the "Other" source switched on (it lets designers type a new source)' });
  }),
  onHoldReasons: list(50).refine((l) => l.length > 0, 'Keep at least one reason'),
  inactiveReasons: list(80).refine((l) => l.length > 0, 'Keep at least one reason'),
  reactivationReasons: list(50).refine((l) => l.length > 0, 'Keep at least one reason'),
  flagCategories: list(50).refine((l) => l.length > 0, 'Keep at least one category'),
  leadCreateRequired: z.array(z.enum(LEAD_DETAIL_FIELDS)),
  discount: z.object({
    selfApproveUpToPct: z.number().min(0).max(100),
    blApproveUpToPct: z.number().min(0).max(100),
    branchHeadUpToPct: z.number().min(0).max(100),
    woodworkSpecialCaseBelow: z.number().min(0).max(1_000_000_000),
  }).strict().refine((d) => d.selfApproveUpToPct <= d.blApproveUpToPct && d.blApproveUpToPct <= d.branchHeadUpToPct,
    'Discount limits must go up: designer ≤ Business Lead ≤ Branch Head'),
  reminderMinutesBefore: z.number().int().min(15, "must be at least 15 minutes (the reminder check runs every 15 minutes)").max(24 * 60),
  /** 0 = Sunday … 6 = Saturday (IST). */
  weeklyDigestDay: z.number().int().min(0).max(6),
  designPhaseDays: z.record(z.enum(DESIGN_PHASE_KEYS), z.number().int().min(1).max(365)),
  designOverallDays: z.number().int().min(1).max(730),
  stageLabels: z.record(z.enum(NAMEABLE_STAGES), text(40)),
  hiddenStages: z.array(z.enum(HIDEABLE_STAGES)),
}).strict();

export type CrmSettings = z.infer<typeof crmSettingsSchema>;

export const DEFAULT_CRM_SETTINGS: CrmSettings = {
  cities: [
    { name: 'Chennai', areas: CHENNAI_AREAS },
    ...['Bengaluru', 'Hyderabad', 'Coimbatore', 'Madurai', 'Trichy', 'Salem', 'Tiruppur', 'Erode', 'Hosur',
      'Vellore', 'Thanjavur', 'Puducherry', 'Pondicherry'].map((name) => ({ name, areas: [] as string[] })),
  ],
  leadSources: [
    ['META_ADS', 'Meta Ads'], ['GOOGLE_ADS', 'Google Ads'], ['REFERRAL', 'Referral'], ['WALK_IN', 'Walk-in'],
    ['ORGANIC', 'Organic'], ['AFFILIATE_MARKETING', 'Affiliate Marketing'], ['WEBSITE', 'Website'],
    ['INSTAGRAM', 'Instagram'], ['WHATSAPP', 'WhatsApp'], ['LINKEDIN', 'LinkedIn'], ['MANUAL', 'Manual'], ['OTHER', 'Other'],
  ].map(([value, label]) => ({ value, label, active: true })),
  onHoldReasons: ['Client Requested', 'Budget Issue', 'Site Not Ready'],
  inactiveReasons: [
    'No Response', 'Budget Constraint', 'Quality Constraint', 'Timeline Constraint',
    "Client Won't Move Out During Execution", 'UPVC Material Required', 'SS Material Required',
    'Stone Material Required', 'Aluminium Material Required', 'No Scope for Interiors',
    'Onboarded with Other Interior', 'Onboarded with Other Vendor', 'Window Shopping',
    'Service Out of Location', 'Project Value Below 5L', 'Repeated Lead', 'Invalid Number',
    'Has Not Bought Property Yet', 'Others',
  ],
  reactivationReasons: ['Client re-engaged', 'Budget approved', 'Timeline resumed', 'Inactivated by Mistake', 'Other'],
  flagCategories: [
    'Delayed internal Response', 'Budget Concern', 'Requirement / Scope Unclear', 'Timeline / TAT Deviation',
    'Process Deviation', 'Communication Deviation', 'Escalation / Cancellation Risk',
  ],
  leadCreateRequired: ['projectType', 'scope', 'location', 'possessionTimeline'],
  discount: { selfApproveUpToPct: 10, blApproveUpToPct: 15, branchHeadUpToPct: 20, woodworkSpecialCaseBelow: 500_000 },
  reminderMinutesBefore: 60,
  weeklyDigestDay: 2,
  designPhaseDays: {
    SITE_DOCUMENTATION: 3, SITE_DISCUSSION: 4, LAYOUT_FINALISATION: 10, DESIGN_DISCUSSION: 7,
    PRE_SIGN_OFF: 7, MASKING: 7, SIGN_OFF: 4, EIP: 3,
  },
  designOverallDays: 45,
  stageLabels: {
    EFFECTIVE_LEAD: 'Effective Lead', MQL: 'MQL', DQL: 'DQL', PROPOSAL_READY: 'Proposal Ready',
    PROPOSAL_PRESENTED: 'Proposal Presented', PROPOSAL_DISCUSSION: 'PD (Pitch Discussion)',
    ONBOARDING: 'Onboarding', ONBOARDING_MEETING: 'Onboarding Meeting',
    DESIGN_IN_PROGRESS: 'Design in Progress', HANDED_OVER: 'Handed Over',
  },
  hiddenStages: [],
};

interface StoredCrmSettings {
  settings: Partial<CrmSettings>;
  revision: number;
  updatedAt: string;
  updatedById: string;
}

/** Saved values over the defaults, section by section (a section added later starts at its default). */
function merge(saved: Partial<CrmSettings> | undefined): CrmSettings {
  const d = DEFAULT_CRM_SETTINGS;
  const s = saved ?? {};
  return {
    ...d,
    ...s,
    discount: { ...d.discount, ...s.discount },
    designPhaseDays: { ...d.designPhaseDays, ...s.designPhaseDays },
    stageLabels: { ...d.stageLabels, ...s.stageLabels },
  };
}

export async function getCrmSettings(): Promise<CrmSettings> {
  const row = await prisma.assignmentConfig.findUnique({ where: { key: CRM_SETTINGS_KEY } });
  return merge((row?.value as StoredCrmSettings | null)?.settings);
}

export class CrmSettingsError extends Error {
  constructor(public status: number, message: string, public problems: string[] = []) { super(message); }
}

const SECTION_NAMES: Record<string, string> = {
  cities: 'Cities', leadSources: 'Lead sources', onHoldReasons: 'On-hold reasons', inactiveReasons: 'Inactive reasons',
  reactivationReasons: 'Reactivation reasons', flagCategories: 'Flag categories', leadCreateRequired: 'New lead details',
  discount: 'Discount limits', reminderMinutesBefore: 'Reminder timing', weeklyDigestDay: 'Weekly digest day',
  designPhaseDays: 'Design phase days', designOverallDays: 'Overall design days', stageLabels: 'Stage names', hiddenStages: 'Switched-off stages',
};

export function validateCrmSettings(raw: unknown): CrmSettings {
  const parsed = crmSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CrmSettingsError(400, 'The settings could not be saved', parsed.error.issues.map((i) => {
      const [section, ...rest] = i.path;
      const where = SECTION_NAMES[String(section)] ?? String(section ?? 'Settings');
      return `${where}${rest.length ? ` (${rest.join(' → ')})` : ''}: ${i.message}`;
    }));
  }
  return parsed.data;
}

export async function loadCrmSettingsState() {
  const row = await prisma.assignmentConfig.findUnique({ where: { key: CRM_SETTINGS_KEY } });
  const stored = row?.value as StoredCrmSettings | null | undefined;
  const updatedBy = stored?.updatedById
    ? await prisma.user.findUnique({ where: { id: stored.updatedById }, select: { name: true } })
    : null;
  return {
    settings: merge(stored?.settings),
    isDefault: !stored,
    revision: stored?.revision ?? 0,
    updatedAt: stored?.updatedAt ?? null,
    updatedByName: updatedBy?.name ?? null,
  };
}

export async function saveCrmSettings(raw: unknown, expectedRevision: unknown, userId: string, note?: string) {
  const settings = validateCrmSettings(raw);
  return prisma.$transaction(async (tx) => {
    const row = await tx.assignmentConfig.findUnique({ where: { key: CRM_SETTINGS_KEY } });
    const current = (row?.value as StoredCrmSettings | null)?.revision ?? 0;
    if (expectedRevision !== current) {
      throw new CrmSettingsError(409, 'Someone else saved the CRM settings since you opened this page. Reload to see their changes, then make yours again.');
    }
    const value: StoredCrmSettings = { settings, revision: current + 1, updatedAt: new Date().toISOString(), updatedById: userId };
    await tx.assignmentConfig.upsert({
      where: { key: CRM_SETTINGS_KEY },
      create: { key: CRM_SETTINGS_KEY, value: value as any },
      update: { value: value as any },
    });
    await tx.activityLog.create({
      data: { userId, action: 'CRM_SETTINGS_UPDATED', meta: { revision: value.revision, settings, ...(note && { note: note.slice(0, 300) }) } as any },
    });
    return value;
  });
}

export async function resetCrmSettings(userId: string) {
  await prisma.assignmentConfig.deleteMany({ where: { key: CRM_SETTINGS_KEY } });
  await logActivity(userId, 'CRM_SETTINGS_RESET', undefined, { settings: DEFAULT_CRM_SETTINGS });
}

export async function crmSettingsHistory(limit = 30) {
  const rows = await prisma.activityLog.findMany({
    where: { action: { in: [...CRM_SETTINGS_ACTIONS] }, leadId: null },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, action: true, createdAt: true, meta: true, user: { select: { name: true } } },
  });
  return rows.map((r) => {
    const meta = (r.meta ?? {}) as { revision?: number; note?: string; settings?: CrmSettings };
    return {
      id: r.id, action: r.action, createdAt: r.createdAt, byName: r.user?.name ?? 'Unknown',
      revision: meta.revision ?? null, note: meta.note ?? null, settings: meta.settings ?? null,
    };
  });
}

/** Display name of a stage under the current settings. */
export function stageName(settings: CrmSettings, stage: string): string {
  return (settings.stageLabels as Record<string, string>)[stage] ?? stage;
}
