import { randomUUID } from 'crypto';
import { supabaseAdmin } from './supabase.js';
import type { EmailAttachment } from './email.js';

export interface MasterMailAttachment {
  storagePath: string;
  name: string;
  size: number;
}
const BUCKET = 'crm-call-attachments'; // existing private application storage
const PREFIX = 'mail-template-master/';
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;

export function validateMasterMailAttachments(value: unknown): MasterMailAttachment[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error('Use at most 10 welcome documents');
  const paths = new Set<string>();
  let total = 0;
  return value.map((file: any) => {
    if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 180
      || /[\\/\r\n]/.test(file.name)
      || typeof file.storagePath !== 'string'
      || !/^mail-template-master\/[0-9a-f-]{36}\/[^/]+$/i.test(file.storagePath)
      || file.storagePath.split('/').pop() !== file.name
      || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE
      || paths.has(file.storagePath)) throw new Error('Invalid welcome document reference');
    paths.add(file.storagePath);
    total += file.size;
    if (total > MAX_TOTAL) throw new Error('Welcome documents must total 20 MB or less');
    return { storagePath: file.storagePath, name: file.name, size: file.size };
  });
}

/** Check an uploaded mail document (PDF, DOCX, PNG, JPG: real file contents, up to 4 MB) and give back its safe name and type. */
export function checkMailDocument(file: Express.Multer.File): { name: string; mime: string } {
  if (!file.size || file.size > MAX_FILE) throw new Error('Each document must be 4 MB or less');
  const ext = file.originalname.split('.').pop()?.toLowerCase();
  const bytes = file.buffer;
  const formats: Record<string, { mime: string; valid: boolean }> = {
    pdf: { mime: 'application/pdf', valid: bytes.subarray(0, 5).toString() === '%PDF-' },
    docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', valid: bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
    png: { mime: 'image/png', valid: bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    jpg: { mime: 'image/jpeg', valid: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    jpeg: { mime: 'image/jpeg', valid: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  };
  const format = formats[ext ?? ''];
  if (!format?.valid) throw new Error('Upload a valid PDF, DOCX, PNG or JPG document');
  return { name: file.originalname.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(-180), mime: format.mime };
}

export async function uploadMasterMailAttachment(file: Express.Multer.File): Promise<MasterMailAttachment> {
  const { name, mime } = checkMailDocument(file);
  const storagePath = `${PREFIX}${randomUUID()}/${name}`;
  if (!supabaseAdmin) throw new Error('Document storage is not configured');
  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(storagePath, file.buffer, {
    contentType: mime, upsert: false,
  });
  if (error) throw new Error(`Could not upload welcome document: ${error.message}`);
  return { storagePath, name, size: file.size };
}

export async function downloadMasterMailAttachments(value: unknown): Promise<EmailAttachment[]> {
  const refs = validateMasterMailAttachments(value);
  const attachments: EmailAttachment[] = [];
  if (refs.length === 0) return attachments;
  if (!supabaseAdmin) throw new Error('Document storage is not configured');
  let actualTotal = 0;
  for (const ref of refs) {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(ref.storagePath);
    if (error || !data) throw new Error(`Welcome document is unavailable: ${ref.name}. Update it in Admin Settings before sending.`);
    actualTotal += data.size;
    if (data.size !== ref.size || actualTotal > MAX_TOTAL) throw new Error('Welcome document size changed; upload the document again');
    attachments.push({ filename: ref.name, content: Buffer.from(await data.arrayBuffer()).toString('base64') });
  }
  return attachments;
}
