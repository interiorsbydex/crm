import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: undefined as any,
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
    assignmentConfig: { findUnique: async () => (state.config ? { value: state.config } : null) },
    leadFile: {
      findFirst: async ({ where }: any) => {
        const types: string[] = where.fileType.in;
        const hit = types.find((t) => state.files[t]);
        return hit ? state.files[hit] : null;
      },
    },
  },
}));
import { welcomeMailFileAttachments, welcomeMailFileRefs, welcomeMailFilesConfig } from './welcomeMailFiles.js';

beforeEach(() => {
  state.config = undefined;
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
    state.config = { value: { attach: { payment: true, obQuote: false, pitch: true } }, revision: 1, updatedAt: '', updatedById: 'x' };
    expect((await welcomeMailFileRefs('lead1')).map((f) => f.fileName)).toEqual(['payment.png', 'pitch.pdf']);
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
  });
});
