/**
 * Checklists (Admin → Checklists): the PD → Onboarding, Onboarding → OBM and
 * OBM → DIP checklists.
 *
 * An admin can make built-in items optional (except the locked ones) and add
 * their own items: a tick, a date, a short text, or "a document is uploaded".
 * evaluateChecklist() is the single place that works out what is still
 * missing; the send/complete routes enforce it and the panels display it.
 * With nothing saved, every built-in item is required, as before.
 */
import { z } from 'zod';
import { prisma } from './prisma.js';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';
import { getNpsSendState } from './npsHelper.js';
import { getDocumentTypes, toStoredFileType } from './documentTypes.js';

export const CHECKLIST_KINDS = ['pdOb', 'obObm', 'dip'] as const;
export type ChecklistKind = (typeof CHECKLIST_KINDS)[number];
export const CHECKLIST_NAMES: Record<ChecklistKind, string> = {
  pdOb: 'PD → Onboarding (welcome mail)',
  obObm: 'Onboarding → OBM (OBM mail)',
  dip: 'OBM → Design in Progress',
};

export interface BuiltInItem { key: string; label: string; lockedReason?: string }

export const OBM_DOC_ITEMS = [
  'dexMaterial', 'creditSystem', 'deepCleaning', 'paymentProcess',
  'warrantyClaim', 'continuity', 'cancellation',
] as const;
export const OBM_DOC_LABELS: Record<(typeof OBM_DOC_ITEMS)[number], string> = {
  dexMaterial: 'Dex material / specification',
  creditSystem: 'Credit system',
  deepCleaning: 'Deep cleaning',
  paymentProcess: 'Payment process',
  warrantyClaim: 'Warranty claim',
  continuity: 'Project continuity / team transition',
  cancellation: 'Cancellation policy',
};
export const OBM_TIMELINE_FIELDS = [
  'siteDocumentationAt', 'initialSiteDiscussionAt', 'layoutFinalisationAt',
  'designDiscussionAt', 'preSignOffAt', 'maskingAt', 'signOffAt',
  'tentativeInteriorHandoverAt',
] as const;
export const OBM_TIMELINE_LABELS: Record<(typeof OBM_TIMELINE_FIELDS)[number], string> = {
  siteDocumentationAt: 'Site documentation date',
  initialSiteDiscussionAt: 'Initial site discussion date',
  layoutFinalisationAt: 'Layout finalisation date',
  designDiscussionAt: 'Design discussion date',
  preSignOffAt: 'Pre sign-off date',
  maskingAt: 'Masking date',
  signOffAt: 'Sign off date',
  tentativeInteriorHandoverAt: 'Tentative interior handover date',
};

const PAYMENT_LOCK = 'Payment proof is what confirms a booking (client decision).';

export const BUILT_IN_ITEMS: Record<ChecklistKind, BuiltInItem[]> = {
  pdOb: [
    { key: 'paymentScreenshot', label: 'Payment screenshot (Files tab)', lockedReason: PAYMENT_LOCK },
    { key: 'obQuote', label: 'OB Quote (Files tab)' },
    { key: 'finalPitchPresentation', label: 'Final Pitch Presentation file (Files → PD or PP if skipping PD)' },
    { key: 'generatedQuotation', label: 'Generated Quotation (Quote Builder or Files → PP/PD)' },
    { key: 'paymentValue', label: 'Payment value' },
    { key: 'projectValue', label: 'Project value (excl. furniture)' },
    { key: 'furnitureValue', label: 'Furniture value' },
    { key: 'obMeetingScheduledAt', label: 'OB meeting date/time' },
    { key: 'obMeetingLocation', label: 'OB meeting location' },
    { key: 'notes', label: 'Notes' },
    { key: 'welcomeMailScreenshot', label: 'Welcome mail approval screenshot (Files tab)' },
  ],
  obObm: [
    ...OBM_DOC_ITEMS.map((k) => ({ key: k, label: OBM_DOC_LABELS[k] })),
    ...OBM_TIMELINE_FIELDS.map((k) => ({ key: k, label: OBM_TIMELINE_LABELS[k] })),
    { key: 'nps', label: 'NPS survey email sent or customer response received', lockedReason: 'NPS at onboarding is mandatory (client decision).' },
    { key: 'clientConfirmed', label: 'Client confirmed' },
  ],
  dip: [
    { key: 'cxApprovalReceived', label: 'CX approval received' },
    { key: 'internalMailThreadCompleted', label: 'Internal mail thread completed' },
    { key: 'paymentScreenshot', label: 'Payment screenshot (Files tab)', lockedReason: PAYMENT_LOCK },
  ],
};

export type CustomKind = 'tick' | 'date' | 'text' | 'document';
export interface CustomItem { key: string; label: string; kind: CustomKind; docType?: string; required: boolean; active: boolean }
export interface ChecklistSettings { optional: string[]; custom: CustomItem[] }
export type ChecklistsConfig = Record<ChecklistKind, ChecklistSettings>;

export function defaultChecklists(): ChecklistsConfig {
  return Object.fromEntries(CHECKLIST_KINDS.map((k) => [k, { optional: [], custom: [] }])) as unknown as ChecklistsConfig;
}

const customSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,40}$/, 'keys use lowercase letters, numbers and _'),
  label: z.string().trim().min(1, 'every item needs a name').max(120, 'item names are limited to 120 characters'),
  kind: z.enum(['tick', 'date', 'text', 'document']),
  docType: z.string().optional(),
  required: z.boolean(),
  active: z.boolean(),
}).strict();
const settingsSchema = z.object({ optional: z.array(z.string()), custom: z.array(customSchema).max(40) }).strict();

async function validateChecklists(raw: unknown): Promise<ChecklistsConfig> {
  const parsed = z.object(Object.fromEntries(CHECKLIST_KINDS.map((k) => [k, settingsSchema.optional()]))).strict().safeParse(raw);
  if (!parsed.success) throw new ConfigError(400, 'The checklists could not be saved', describeIssues(parsed.error.issues, CHECKLIST_NAMES));
  const docKeys = new Set((await getDocumentTypes()).filter((t) => t.active).map((t) => t.key));
  const problems: string[] = [];
  const out = defaultChecklists();
  for (const kind of CHECKLIST_KINDS) {
    const s = parsed.data[kind];
    if (!s) continue;
    const builtIn = new Map(BUILT_IN_ITEMS[kind].map((i) => [i.key, i]));
    for (const key of s.optional) {
      const item = builtIn.get(key);
      if (!item) problems.push(`${CHECKLIST_NAMES[kind]}: unknown item "${key}"`);
      else if (item.lockedReason) problems.push(`${CHECKLIST_NAMES[kind]}: "${item.label}" can't be optional — ${item.lockedReason}`);
    }
    const keys = new Set<string>();
    for (const c of s.custom) {
      if (keys.has(c.key) || builtIn.has(c.key)) problems.push(`${CHECKLIST_NAMES[kind]}: "${c.label}" uses a key that's already taken`);
      keys.add(c.key);
      if (c.kind === 'document' && (!c.docType || !docKeys.has(c.docType))) problems.push(`${CHECKLIST_NAMES[kind]}: "${c.label}" needs a document type that's in use`);
    }
    out[kind] = { optional: s.optional.filter((k) => builtIn.has(k) && !builtIn.get(k)!.lockedReason), custom: s.custom };
  }
  if (problems.length) throw new ConfigError(400, 'The checklists could not be saved', problems);
  return out;
}

export const checklistsConfig = versionedConfig<ChecklistsConfig>({
  key: 'checklists_v1',
  action: 'CHECKLISTS',
  noun: 'the checklists',
  defaults: defaultChecklists,
  merge: (saved) => ({ ...defaultChecklists(), ...(saved ?? {}) }),
  validate: validateChecklists,
});

export interface ChecklistItemStatus {
  key: string;
  label: string;
  met: boolean;
  required: boolean;
  locked: boolean;
  custom?: { kind: CustomKind; docType?: string; value: unknown };
}

const hasText = (v: unknown) => typeof v === 'string' ? v.trim().length > 0 : v != null;
const QUOTE_FILES = ['OB_QUOTE', 'QUOTATION', 'PR_QUOTATION', 'PP_QUOTATION', 'GENERATED_QUOTE'];

async function fileExists(leadId: string, fileTypes: string[]) {
  return !!(await prisma.leadFile.findFirst({ where: { leadId, fileType: { in: fileTypes as any } }, select: { id: true } }));
}

/** Whether each built-in item is done, for this checklist row. */
async function builtInMet(kind: ChecklistKind, leadId: string, row: Record<string, any>): Promise<Record<string, boolean>> {
  if (kind === 'pdOb') {
    const [payment, obQuote, finalPitch, quoteRow, quoteFile, welcomeShot] = await Promise.all([
      fileExists(leadId, ['PAYMENT_SCREENSHOT']),
      fileExists(leadId, QUOTE_FILES),
      fileExists(leadId, ['PITCH_PRESENTATION', 'FINAL_PITCH_PRESENTATION']),
      prisma.quote.findFirst({ where: { leadId }, select: { id: true } }),
      fileExists(leadId, QUOTE_FILES),
      fileExists(leadId, ['WELCOME_MAIL_SCREENSHOT']),
    ]);
    return {
      paymentScreenshot: payment, obQuote, finalPitchPresentation: finalPitch, generatedQuotation: !!quoteRow || quoteFile,
      paymentValue: row.paymentValue != null, projectValue: row.projectValue != null, furnitureValue: row.furnitureValue != null,
      obMeetingScheduledAt: !!row.obMeetingScheduledAt, obMeetingLocation: hasText(row.obMeetingLocation),
      notes: hasText(row.notes), welcomeMailScreenshot: welcomeShot,
    };
  }
  if (kind === 'obObm') {
    const nps = (await getNpsSendState(leadId, 'ONBOARDING')).status !== 'NOT_SENT';
    return {
      ...Object.fromEntries(OBM_DOC_ITEMS.map((k) => [k, !!row[`${k}Done`]])),
      ...Object.fromEntries(OBM_TIMELINE_FIELDS.map((k) => [k, !!row[k]])),
      nps,
      clientConfirmed: !!row.clientConfirmed,
    };
  }
  return {
    cxApprovalReceived: !!row.cxApprovalReceived,
    internalMailThreadCompleted: !!row.internalMailThreadCompleted,
    paymentScreenshot: await fileExists(leadId, ['PAYMENT_SCREENSHOT']),
  };
}

async function customMet(leadId: string, item: CustomItem, values: Record<string, unknown>): Promise<boolean> {
  if (item.kind === 'document') {
    if (!item.docType) return false;
    const stored = toStoredFileType(item.docType);
    return !!(await prisma.leadFile.findFirst({
      where: { leadId, fileType: stored.fileType as any, ...(stored.customType ? { customType: stored.customType } : {}) },
      select: { id: true },
    }));
  }
  const v = values[item.key];
  if (item.kind === 'tick') return v === true;
  return hasText(v);
}

/** Every item on the checklist with whether it's done, and the required ones still missing. */
export async function evaluateChecklist(kind: ChecklistKind, leadId: string, row: Record<string, any>) {
  const settings = (await checklistsConfig.get())[kind];
  const met = await builtInMet(kind, leadId, row);
  const values = (row.customValues ?? {}) as Record<string, unknown>;
  const items: ChecklistItemStatus[] = BUILT_IN_ITEMS[kind].map((i) => ({
    key: i.key, label: i.label, met: !!met[i.key], locked: !!i.lockedReason,
    required: !!i.lockedReason || !settings.optional.includes(i.key),
  }));
  for (const c of settings.custom.filter((x) => x.active)) {
    items.push({
      key: c.key, label: c.label, met: await customMet(leadId, c, values), required: c.required, locked: false,
      custom: { kind: c.kind, docType: c.docType, value: values[c.key] ?? null },
    });
  }
  const missing = items.filter((i) => i.required && !i.met).map((i) => i.label);
  return { items, missing };
}

/** Check and merge custom-item values sent by a checklist panel. */
export async function mergeCustomValues(kind: ChecklistKind, current: unknown, incoming: unknown): Promise<Record<string, unknown>> {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new ConfigError(400, 'customValues must be an object');
  const defs = new Map((await checklistsConfig.get())[kind].custom.map((c) => [c.key, c]));
  const out = { ...((current ?? {}) as Record<string, unknown>) };
  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    const def = defs.get(key);
    if (!def || def.kind === 'document') throw new ConfigError(400, `"${key}" isn't an item you can fill in on this checklist`);
    if (value === null) { delete out[key]; continue; }
    if (def.kind === 'tick' && typeof value !== 'boolean') throw new ConfigError(400, `${def.label}: must be ticked or unticked`);
    if (def.kind === 'date' && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) throw new ConfigError(400, `${def.label}: must be a date`);
    if (def.kind === 'text' && (typeof value !== 'string' || value.length > 2000)) throw new ConfigError(400, `${def.label}: must be text up to 2000 characters`);
    out[key] = value;
  }
  return out;
}
