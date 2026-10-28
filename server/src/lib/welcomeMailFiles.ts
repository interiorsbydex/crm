/**
 * Which of the lead's own files go out with the PD→OB welcome mail
 * (Admin → Welcome Mail). Each ticked kind attaches the newest file of that
 * kind from the lead's Files tab; a kind with no file is simply left out and
 * the review screen lists exactly what is attached.
 */
import { z } from 'zod';
import { prisma } from './prisma.js';
import { supabaseAdmin } from './supabase.js';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';
import { getDocumentTypes, toStoredFileType } from './documentTypes.js';
import type { EmailAttachment } from './email.js';

export const WELCOME_FILE_KINDS = [
  { key: 'payment', label: 'Payment screenshot', fileTypes: ['PAYMENT_SCREENSHOT'] },
  { key: 'obQuote', label: 'OB quotation', fileTypes: ['OB_QUOTE', 'QUOTATION', 'PR_QUOTATION', 'PP_QUOTATION', 'GENERATED_QUOTE'] },
  { key: 'pitch', label: 'Pitch presentation', fileTypes: ['PITCH_PRESENTATION', 'FINAL_PITCH_PRESENTATION'] },
] as const;
export type WelcomeFileKey = (typeof WELCOME_FILE_KINDS)[number]['key'];
export interface WelcomeMailFiles {
  attach: Record<WelcomeFileKey, boolean>;
  /** Any other document types (Admin → Document Types, including her own) to attach too. */
  extraTypes: string[];
  /** What to do when a ticked kind has no file on the lead: leave it out, or stop and tell the sender. */
  whenMissing: 'skip' | 'block';
}

const LEAD_FILES_BUCKET = 'crm-lead-files';
const MAX_TOTAL = 20 * 1024 * 1024;

export function defaultWelcomeMailFiles(): WelcomeMailFiles {
  return { attach: { payment: true, obQuote: true, pitch: true }, extraTypes: [], whenMissing: 'skip' };
}

const schema = z.object({
  attach: z.object({ payment: z.boolean(), obQuote: z.boolean(), pitch: z.boolean() }).strict(),
  extraTypes: z.array(z.string()).max(30),
  whenMissing: z.enum(['skip', 'block']),
}).strict();

export const welcomeMailFilesConfig = versionedConfig<WelcomeMailFiles>({
  key: 'welcome_mail_files_v1',
  action: 'WELCOME_MAIL_FILES',
  noun: 'the welcome mail files',
  defaults: defaultWelcomeMailFiles,
  merge: (saved) => ({ ...defaultWelcomeMailFiles(), ...(saved ?? {}), attach: { ...defaultWelcomeMailFiles().attach, ...(saved?.attach ?? {}) } }),
  validate: async (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ConfigError(400, 'The welcome mail files could not be saved', describeIssues(parsed.error.issues, {}));
    const inUse = new Set((await getDocumentTypes()).filter((t) => t.active).map((t) => t.key));
    const bad = parsed.data.extraTypes.filter((k) => !inUse.has(k));
    if (bad.length) throw new ConfigError(400, 'The welcome mail files could not be saved', bad.map((k) => `"${k}" is not a document type that is in use`));
    return { ...parsed.data, extraTypes: [...new Set(parsed.data.extraTypes)] };
  },
});

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** The newest file of each ticked kind, with the file's own name, and the kinds with no file. */
export async function welcomeMailFileRefs(leadId: string) {
  const { attach, extraTypes } = await welcomeMailFilesConfig.get();
  const refs: { kind: string; fileName: string; storagePath: string }[] = [];
  const missing: string[] = [];
  for (const kind of WELCOME_FILE_KINDS) {
    if (!attach[kind.key]) continue;
    const file = await prisma.leadFile.findFirst({
      where: { leadId, fileType: { in: kind.fileTypes as any } },
      orderBy: { createdAt: 'desc' },
      select: { fileName: true, storagePath: true },
    });
    if (file) refs.push({ kind: kind.label, ...file }); else missing.push(kind.label);
  }
  if (extraTypes.length) {
    const labels = new Map((await getDocumentTypes()).map((t) => [t.key, t.label]));
    for (const key of extraTypes) {
      const stored = toStoredFileType(key);
      const file = await prisma.leadFile.findFirst({
        where: { leadId, fileType: stored.fileType as any, ...(stored.customType ? { customType: stored.customType } : {}) },
        orderBy: { createdAt: 'desc' },
        select: { fileName: true, storagePath: true },
      });
      const label = labels.get(key) ?? key;
      if (file) refs.push({ kind: label, ...file }); else missing.push(label);
    }
  }
  return { refs, missing };
}

/** The same files, downloaded and ready to attach. Refuses if they total more than 20 MB. */
export async function welcomeMailFileAttachments(leadId: string): Promise<EmailAttachment[]> {
  const { refs, missing } = await welcomeMailFileRefs(leadId);
  if (missing.length && (await welcomeMailFilesConfig.get()).whenMissing === 'block') {
    throw new ConfigError(400, `Cannot send welcome mail — upload on the Files tab: ${missing.join(', ')}. (Admin → Welcome Mail can change this rule.)`);
  }
  if (!refs.length) return [];
  if (!supabaseAdmin) throw new ConfigError(500, 'Document storage is not configured');
  const out: EmailAttachment[] = [];
  let total = 0;
  for (const ref of refs) {
    const legacy = ref.storagePath.startsWith('crm-files:');
    const { data, error } = await supabaseAdmin.storage
      .from(legacy ? 'crm-files' : LEAD_FILES_BUCKET)
      .download(legacy ? ref.storagePath.slice('crm-files:'.length) : ref.storagePath);
    if (error || !data) throw new ConfigError(400, `The ${ref.kind.toLowerCase()} "${ref.fileName}" could not be read from storage. Upload it again on the Files tab.`);
    total += data.size;
    if (total > MAX_TOTAL) throw new ConfigError(400, 'The files to attach add up to more than 20 MB. Upload smaller files, or switch some off in Admin → Welcome Mail.');
    const ext = ref.fileName.split('.').pop()?.toLowerCase() ?? '';
    out.push({ filename: ref.fileName, content: Buffer.from(await data.arrayBuffer()).toString('base64'), ...(MIME[ext] && { contentType: MIME[ext] }) });
  }
  return out;
}
