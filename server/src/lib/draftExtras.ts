/**
 * Files a person adds to one outgoing mail on its review screen ("Attach files").
 * They wait in a row of their own per lead and person; when that person sends
 * any mail for the lead (sendDraft in emailService.ts) they travel with it and
 * the row is cleared, so every reviewed mail can carry files without each
 * screen having to pass them along.
 */
import { prisma } from './prisma.js';
import { checkMailDocument } from './mailTemplateAttachments.js';
import type { EmailAttachment } from './email.js';

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

export const extrasKey = (leadId: string, userId: string) => `${leadId}::EXTRAS::${userId}`;
const bytesOf = (a: EmailAttachment) => Buffer.from(a.content, 'base64').length;

async function read(leadId: string, userId: string): Promise<EmailAttachment[]> {
  const row = await prisma.emailDraft.findUnique({ where: { key: extrasKey(leadId, userId) } });
  return (row?.attachments as unknown as EmailAttachment[] | null) ?? [];
}
async function write(leadId: string, userId: string, files: EmailAttachment[]) {
  const key = extrasKey(leadId, userId);
  if (!files.length) { await prisma.emailDraft.deleteMany({ where: { key } }); return; }
  await prisma.emailDraft.upsert({
    where: { key },
    create: { key, subject: '', html: '', attachments: files as any },
    update: { attachments: files as any },
  });
}

export const listExtras = async (leadId: string, userId: string) =>
  (await read(leadId, userId)).map((a) => ({ filename: a.filename, size: bytesOf(a) }));

export async function addExtra(leadId: string, userId: string, file: Express.Multer.File) {
  const { name, mime } = checkMailDocument(file);
  const files = await read(leadId, userId);
  if (files.length >= MAX_FILES) throw new Error(`Attach at most ${MAX_FILES} files to one mail`);
  if (files.some((f) => f.filename === name)) throw new Error(`"${name}" is already attached`);
  if (files.reduce((s, f) => s + bytesOf(f), 0) + file.size > MAX_TOTAL_BYTES) throw new Error('Files added to one mail must total 15 MB or less');
  await write(leadId, userId, [...files, { filename: name, content: file.buffer.toString('base64'), contentType: mime }]);
  return listExtras(leadId, userId);
}

export async function removeExtra(leadId: string, userId: string, filename: string) {
  await write(leadId, userId, (await read(leadId, userId)).filter((f) => f.filename !== filename));
  return listExtras(leadId, userId);
}

export async function clearExtras(leadId: string, userId: string) {
  await prisma.emailDraft.deleteMany({ where: { key: extrasKey(leadId, userId) } });
}

/** The files waiting for this person's next mail on the lead. */
export const takeExtras = (leadId: string, userId: string) => read(leadId, userId);
