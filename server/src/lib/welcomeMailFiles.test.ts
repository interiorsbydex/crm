import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  configs: {} as Record<string, any>,
  files: {} as Record<string, { fileName: string; storagePath: string }>,
  blobs: {} as Record<string, Buffer>,
}));
vi.mock('./supabase.js', () => ({
  supabaseAdmin: {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          const b = state.blobs[`${bucket}/${path}`];
          return b ? { data: { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }, error: null } : { data: null, error: { message: 'missing' } };
        },
      }),
    },
  },
}));
vi.mock('./prisma.js', () => ({
  prisma: {
    assignmentConfig: { findUnique: async ({ where }: any) => (state.configs[where.key] ? { value: state.configs[where.key] } : null) },
    leadFile: {
      findFirst: async ({ where }: any) => {
        if (typeof where.fileType === 'string') return state.files[where.customType ? `custom:${where.customType}` : where.fileType] ?? null;
        const types: string[] = where.fileType.in;
        const hit = types.find((t) => state.files[t]);
        return hit ? state.files[hit] : null;
      },
    },
  },
}));
import { welcomeMailFileAttachments, welcomeMailFileRefs, welcomeMailFilesConfig } from './welcomeMailFiles.js';

beforeEach(() => {
  state.configs = {};
  state.files = {
    PAYMENT_SCREENSHOT: { fileName: 'payment.png', storagePath: 'lead1/MQL/1_payment.png' },
    OB_QUOTE: { fileName: 'quote.pdf', storagePath: 'lead1/MQL/2_quote.pdf' },
    PITCH_PRESENTATION: { fileName: 'pitch.pdf', storagePath: 'lead1/DQL/3_pitch.pdf' },
  };
  state.blobs = {
    'crm-lead-files/lead1/MQL/1_payment.png': Buffer.from('png'),
    'crm-lead-files/lead1/MQL/2_quote.pdf': Buffer.from('%PDF-quote'),
    'crm-lead-files/lead1/DQL/3_pitch.pdf': Buffer.from('%PDF-pitch'),
  };
});

describe('welcome mail files', () => {
  it('attaches the payment screenshot, OB quotation and pitch presentation by default', async () => {
    const files = await welcomeMailFileAttachments('lead1');
    expect(files.map((f) => f.filename)).toEqual(['payment.png', 'quote.pdf', 'pitch.pdf']);
    expect(files[0].contentType).toBe('image/png');
    expect(Buffer.from(files[1].content, 'base64').toString()).toBe('%PDF-quote');
  });

  it('leaves out a kind Annie switched off', async () => {
    state.configs.welcome_mail_files_v1 = { value: { attach: { payment: true, obQuote: false, pitch: true }, extraTypes: [], whenMissing: 'skip' }, revision: 1, updatedAt: '', updatedById: 'x' };
    expect((await welcomeMailFileRefs('lead1')).refs.map((f) => f.fileName)).toEqual(['payment.png', 'pitch.pdf']);
  });

  it('leaves out a kind the lead has no file for, without failing', async () => {
    delete state.files.PITCH_PRESENTATION;
    expect((await welcomeMailFileAttachments('lead1')).map((f) => f.filename)).toEqual(['payment.png', 'quote.pdf']);
  });

  it('says plainly when a file cannot be read, and when the files are too big', async () => {
    delete state.blobs['crm-lead-files/lead1/MQL/2_quote.pdf'];
    await expect(welcomeMailFileAttachments('lead1')).rejects.toThrow(/OB quotation "quote.pdf" could not be read/i);
    state.blobs['crm-lead-files/lead1/MQL/2_quote.pdf'] = Buffer.alloc(21 * 1024 * 1024);
    await expect(welcomeMailFileAttachments('lead1')).rejects.toThrow(/more than 20 MB/);
  });

  it('refuses a settings value that is not three on/off choices', async () => {
    await expect(Promise.resolve().then(() => welcomeMailFilesConfig.spec.validate({ attach: { payment: true } }))).rejects.toThrow(/could not be saved/);
    await expect(Promise.resolve().then(() => welcomeMailFilesConfig.spec.validate({ attach: { payment: true, obQuote: true, pitch: true }, extraTypes: ['NOT_A_TYPE'], whenMissing: 'skip' }))).rejects.toThrow(/could not be saved/);
  });

  it('attaches any other document type she ticks, including her own custom ones', async () => {
    state.configs.document_types_v1 = { overrides: { builtIn: {}, custom: [{ key: 'site_photos', label: 'Site photos', pdfOnly: false, active: true }] }, revision: 1 };
    state.configs.welcome_mail_files_v1 = { value: { attach: { payment: false, obQuote: false, pitch: false }, extraTypes: ['custom:site_photos'], whenMissing: 'skip' }, revision: 1, updatedAt: '', updatedById: 'x' };
    state.files['custom:site_photos'] = { fileName: 'site.jpg', storagePath: 'lead1/MQL/4_site.jpg' };
    state.blobs['crm-lead-files/lead1/MQL/4_site.jpg'] = Buffer.from('jpg');
    expect((await welcomeMailFileAttachments('lead1')).map((f) => f.filename)).toEqual(['site.jpg']);
  });

  it('stops and names the missing file when she chose to be strict', async () => {
    state.configs.welcome_mail_files_v1 = { value: { attach: { payment: true, obQuote: true, pitch: true }, extraTypes: [], whenMissing: 'block' }, revision: 1, updatedAt: '', updatedById: 'x' };
    delete state.files.PITCH_PRESENTATION;
    await expect(welcomeMailFileAttachments('lead1')).rejects.toThrow(/upload on the Files tab: Pitch presentation/);
  });
});
