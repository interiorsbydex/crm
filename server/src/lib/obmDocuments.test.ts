import { describe, expect, it } from 'vitest';
import { obmDocumentsConfig } from './obmDocuments.js';
import { checkMailDocument } from './mailTemplateAttachments.js';

const ref = (name: string, size = 1000) => ({ storagePath: `mail-template-master/123e4567-e89b-12d3-a456-426614174000/${name}`, name, size });
const empty = { dexMaterial: [], creditSystem: [], deepCleaning: [], paymentProcess: [], warrantyClaim: [], continuity: [], cancellation: [] };
const validate = async (v: unknown) => obmDocumentsConfig.spec.validate(v);
const file = (name: string, bytes: Buffer): any => ({ originalname: name, size: bytes.length, buffer: bytes });

describe('checklist documents', () => {
  it('starts with no documents for any item', () => {
    expect(obmDocumentsConfig.spec.defaults().docs.creditSystem).toEqual([]);
  });
  it('accepts documents per item and fills in items that are not mentioned', async () => {
    const v = await validate({ docs: { ...empty, creditSystem: [ref('Credit system.pdf')] } });
    expect(v.docs.creditSystem).toHaveLength(1);
    expect(v.docs.cancellation).toEqual([]);
  });
  it('refuses a document that was not uploaded through Admin, or is too big, in plain words', async () => {
    await expect(validate({ docs: { ...empty, creditSystem: [{ storagePath: 'somewhere/else.pdf', name: 'else.pdf', size: 10 }] } }))
      .rejects.toMatchObject({ problems: [expect.stringMatching(/Credit system.*Invalid welcome document reference/)] });
    await expect(validate({ docs: { ...empty, deepCleaning: [ref('big.pdf', 5 * 1024 * 1024)] } })).rejects.toMatchObject({ problems: [expect.stringMatching(/Deep cleaning/)] });
  });
  it('keeps all the documents together under 20 MB', async () => {
    const big = (n: string) => ref(n, 4 * 1024 * 1024);
    await expect(validate({ docs: { ...empty, dexMaterial: [big('a.pdf'), big('b.pdf'), big('c.pdf')], creditSystem: [big('d.pdf'), big('e.pdf'), big('f.pdf')] } }))
      .rejects.toMatchObject({ problems: expect.arrayContaining([expect.stringMatching(/20 MB/)]) });
  });
});

describe('documents added to a mail', () => {
  it('accepts real PDF, PNG, JPG and DOCX contents and cleans the name', () => {
    expect(checkMailDocument(file('Plan v2?.pdf', Buffer.from('%PDF-1.4 x')))).toEqual({ name: 'Plan v2_.pdf', mime: 'application/pdf' });
    expect(checkMailDocument(file('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])))).toMatchObject({ mime: 'image/jpeg' });
    expect(checkMailDocument(file('a.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1])))).toMatchObject({ name: 'a.docx' });
  });
  it('refuses a renamed file, an unsupported type and a file over 4 MB', () => {
    expect(() => checkMailDocument(file('fake.pdf', Buffer.from('not a pdf')))).toThrow(/valid PDF, DOCX, PNG or JPG/);
    expect(() => checkMailDocument(file('run.exe', Buffer.from('MZ')))).toThrow(/valid PDF, DOCX, PNG or JPG/);
    expect(() => checkMailDocument({ originalname: 'big.pdf', size: 5 * 1024 * 1024, buffer: Buffer.from('%PDF-') } as any)).toThrow(/4 MB/);
  });
});
