import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  value: {} as Record<string, any>,
  download: vi.fn(),
  upload: vi.fn(),
}));
vi.mock('./supabase.js', () => ({
  supabaseAdmin: { storage: { from: () => ({ download: state.download, upload: state.upload }) } },
}));
vi.mock('./prisma.js', () => ({
  prisma: {
    assignmentConfig: {
      findUnique: async () => ({ value: state.value }),
      upsert: async ({ update }: any) => { state.value = update.value; return {}; },
    },
  },
}));
import { downloadMasterMailAttachments, uploadMasterMailAttachment, validateMasterMailAttachments } from './mailTemplateAttachments.js';
import { getWelcomeMailAttachments, resetMailTemplateOverride, setMailTemplateOverride } from './mailTemplates.js';

const pdf = Buffer.from('%PDF-1.4\nSynthetic approved document only.');
const reference = {
  name: 'approved.pdf',
  storagePath: 'mail-template-master/11111111-1111-4111-8111-111111111111/approved.pdf',
  size: pdf.length,
};
beforeEach(() => {
  state.value = {};
  state.download.mockReset();
  state.upload.mockReset();
  state.upload.mockResolvedValue({ error: null });
  state.download.mockImplementation(async () => ({ data: new Blob([pdf]), error: null }));
});

describe('Private master welcome documents', () => {
  it('downloads private file bytes as real mail attachments, not public links', async () => {
    expect(await downloadMasterMailAttachments([reference])).toEqual([{ filename: 'approved.pdf', content: pdf.toString('base64') }]);
    expect(state.download).toHaveBeenCalledWith(reference.storagePath);
  });
  it('keeps unconfigured documents non-blocking and distinguishable from failed downloads', async () => {
    expect(await downloadMasterMailAttachments([])).toEqual([]);
    expect(state.download).not.toHaveBeenCalled();
  });
  it('does not silently omit a configured but unavailable document', async () => {
    state.download.mockResolvedValueOnce({ data: null, error: { message: 'Missing' } });
    await expect(downloadMasterMailAttachments([reference])).rejects.toThrow('Update it in Admin Settings');
  });
  it('rejects a changed or corrupted stored file', async () => {
    state.download.mockResolvedValueOnce({ data: new Blob(['different']), error: null });
    await expect(downloadMasterMailAttachments([reference])).rejects.toThrow('size changed');
  });
  it.each([
    [{ ...reference, storagePath: 'leads/private-client-file.pdf' }],
    [{ ...reference, storagePath: 'https://external.invalid/file.pdf' }],
    [{ ...reference, name: '../other.pdf' }],
    [{ ...reference, size: 5 * 1024 * 1024 }],
    [reference, reference],
  ])('rejects unsafe or duplicate file references: %j', (...files: any[]) => {
    expect(() => validateMasterMailAttachments(files)).toThrow();
  });
  it('rejects documents exceeding the total mail size limit', () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      ...reference, size: 4 * 1024 * 1024,
      storagePath: `mail-template-master/11111111-1111-4111-8111-${String(i).padStart(12, '0')}/approved.pdf`,
    }));
    expect(() => validateMasterMailAttachments(files)).toThrow('20 MB');
  });
  it('uploads a verified document under an Admin-owned prefix, with no made-up lead', async () => {
    const file = { originalname: 'approved.pdf', size: pdf.length, buffer: pdf } as Express.Multer.File;
    const result = await uploadMasterMailAttachment(file);
    expect(result.storagePath).toMatch(/^mail-template-master\/[0-9a-f-]+\/approved.pdf$/);
    expect(state.upload).toHaveBeenCalledOnce();
    expect(validateMasterMailAttachments([result])).toHaveLength(1);
  });
  it('rejects content pretending to be a PDF', async () => {
    const file = { originalname: 'approved.pdf', size: 11, buffer: Buffer.from('not a PDF!!') } as Express.Multer.File;
    await expect(uploadMasterMailAttachment(file)).rejects.toThrow('valid PDF');
    expect(state.upload).not.toHaveBeenCalled();
  });
});

describe('Master document configuration', () => {
  it('preserves existing documents when only template text is edited', async () => {
    state.value = { OB_OBM_WELCOME: { attachments: [reference] } };
    await setMailTemplateOverride('OB_OBM_WELCOME', 'Updated', '<p>Updated</p>');
    expect(await getWelcomeMailAttachments()).toEqual([reference]);
  });
  it('resets text without removing approved documents', async () => {
    state.value = { OB_OBM_WELCOME: { subject: 'Edited', html: 'Edited', attachments: [reference] } };
    await resetMailTemplateOverride('OB_OBM_WELCOME');
    expect(state.value.OB_OBM_WELCOME).toEqual({ attachments: [reference] });
  });
  it('can replace or remove future attachments without deleting sent copies or storage objects', async () => {
    await setMailTemplateOverride('OB_OBM_WELCOME', 'Welcome', '<p>Welcome</p>', [reference]);
    expect(await getWelcomeMailAttachments()).toEqual([reference]);
    await setMailTemplateOverride('OB_OBM_WELCOME', 'Welcome', '<p>Welcome</p>', []);
    expect(await getWelcomeMailAttachments()).toEqual([]);
  });
});
