/**
 * Document types offered on the Files tab and usable in stage rules.
 *
 * Built-in types are the LeadFileType enum values; an admin can rename them
 * and choose whether they must be PDFs. Admin-defined types are stored as
 * fileType OTHER + LeadFile.customType = <key>, and referenced everywhere else
 * (stage rules, the Files tab) as `custom:<key>`.
 *
 * Saved overrides live in AssignmentConfig under DOCUMENT_TYPES_CONFIG_KEY;
 * with nothing saved the built-in defaults below apply unchanged.
 */
import { z } from 'zod';
import { prisma } from './prisma.js';
import { CUSTOM_DOC_PREFIX } from '../config/stageRequirements.js';

export const DOCUMENT_TYPES_CONFIG_KEY = 'document_types_v1';

export const BUILT_IN_DOCUMENT_TYPES: { key: string; label: string; pdfOnly: boolean }[] = [
  { key: 'FLOOR_PLAN', label: 'Floor Plan', pdfOnly: false },
  { key: 'LIFESTYLE_CAPTURE', label: 'Lifestyle Capture', pdfOnly: false },
  { key: 'PITCH_PRESENTATION', label: 'Pitch Presentation', pdfOnly: true },
  { key: 'QUOTATION', label: 'Quotation', pdfOnly: true },
  { key: 'GENERATED_QUOTE', label: 'Generated Quote', pdfOnly: true },
  { key: 'PAYMENT_SCREENSHOT', label: 'Payment Screenshot', pdfOnly: false },
  { key: 'OB_QUOTE', label: 'OB Quote', pdfOnly: true },
  { key: 'WELCOME_MAIL_SCREENSHOT', label: 'Welcome Mail Approval Screenshot', pdfOnly: false },
  { key: 'FINAL_PITCH_PRESENTATION', label: 'Final Pitch Presentation', pdfOnly: true },
  { key: 'PP_QUOTATION', label: 'PP Quotation', pdfOnly: true },
  { key: 'PR_QUOTATION', label: 'PR quotation', pdfOnly: true },
  { key: 'PR_PRESENTATION', label: 'PR presentation', pdfOnly: true },
  { key: 'OTHER', label: 'Other', pdfOnly: false },
];

export interface DocumentTypeOverrides {
  /** Per built-in type: renamed label and/or PDF-only switch. */
  builtIn: Record<string, { label?: string; pdfOnly?: boolean }>;
  custom: { key: string; label: string; pdfOnly: boolean; active: boolean }[];
}

export interface DocumentType {
  /** Built-in enum value, or `custom:<key>`. */
  key: string;
  label: string;
  pdfOnly: boolean;
  builtIn: boolean;
  active: boolean;
}

const label = z.string().trim().min(1, 'Name cannot be empty').max(80, 'Name is too long (max 80 characters)');
const builtInKeys = BUILT_IN_DOCUMENT_TYPES.map((t) => t.key) as [string, ...string[]];

export const documentTypeOverridesSchema = z.object({
  builtIn: z.record(z.enum(builtInKeys), z.object({ label: label.optional(), pdfOnly: z.boolean().optional() }).strict()).default({}),
  custom: z.array(z.object({
    key: z.string().regex(/^[a-z0-9_]{2,40}$/, 'Keys use lowercase letters, numbers and _ (2–40 characters)'),
    label,
    pdfOnly: z.boolean(),
    active: z.boolean(),
  }).strict()).max(100).default([]),
}).strict().superRefine((v, ctx) => {
  const keys = new Set<string>();
  const names = new Set(BUILT_IN_DOCUMENT_TYPES.map((t) => (v.builtIn[t.key]?.label ?? t.label).toLowerCase()));
  v.custom.forEach((c, i) => {
    if (keys.has(c.key)) ctx.addIssue({ code: 'custom', path: ['custom', i, 'key'], message: `Duplicate key "${c.key}"` });
    keys.add(c.key);
    if (c.active && names.has(c.label.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['custom', i, 'label'], message: `"${c.label}" is already used by another document type` });
    if (c.active) names.add(c.label.toLowerCase());
  });
});

export async function loadDocumentTypeOverrides(): Promise<{ overrides: DocumentTypeOverrides; revision: number; updatedAt: string | null }> {
  const row = await prisma.assignmentConfig.findUnique({ where: { key: DOCUMENT_TYPES_CONFIG_KEY } });
  const v = row?.value as { overrides?: DocumentTypeOverrides; revision?: number; updatedAt?: string } | null;
  return {
    overrides: v?.overrides ?? { builtIn: {}, custom: [] },
    revision: v?.revision ?? 0,
    updatedAt: v?.updatedAt ?? null,
  };
}

export function resolveDocumentTypes(overrides: DocumentTypeOverrides): DocumentType[] {
  return [
    ...BUILT_IN_DOCUMENT_TYPES.map((t) => ({
      key: t.key,
      label: overrides.builtIn[t.key]?.label ?? t.label,
      pdfOnly: overrides.builtIn[t.key]?.pdfOnly ?? t.pdfOnly,
      builtIn: true,
      active: true,
    })),
    ...overrides.custom.map((c) => ({
      key: `${CUSTOM_DOC_PREFIX}${c.key}`, label: c.label, pdfOnly: c.pdfOnly, builtIn: false, active: c.active,
    })),
  ];
}

export async function getDocumentTypes(): Promise<DocumentType[]> {
  return resolveDocumentTypes((await loadDocumentTypeOverrides()).overrides);
}

/** Split a document-type key into what is stored on LeadFile. */
export function toStoredFileType(key: string): { fileType: string; customType: string | null } {
  return key.startsWith(CUSTOM_DOC_PREFIX)
    ? { fileType: 'OTHER', customType: key.slice(CUSTOM_DOC_PREFIX.length) }
    : { fileType: key, customType: null };
}

/** The document-type key for a stored LeadFile row. */
export function documentTypeKey(file: { fileType: string; customType?: string | null }): string {
  return file.fileType === 'OTHER' && file.customType ? `${CUSTOM_DOC_PREFIX}${file.customType}` : file.fileType;
}
