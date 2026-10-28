/**
 * Standard documents for the Onboarding → OBM checklist (Admin → Checklist
 * Documents): one set of files per checklist item (Dex material, Credit system,
 * Deep cleaning, …). When an item is ticked on a lead, its documents go out
 * with the OBM mail automatically.
 */
import { z } from 'zod';
import { ConfigError, versionedConfig } from './versionedConfig.js';
import { OBM_DOC_ITEMS, OBM_DOC_LABELS } from './checklists.js';
import { downloadMasterMailAttachments, validateMasterMailAttachments, type MasterMailAttachment } from './mailTemplateAttachments.js';
import type { EmailAttachment } from './email.js';

type DocItem = (typeof OBM_DOC_ITEMS)[number];
export interface ObmDocuments { docs: Record<DocItem, MasterMailAttachment[]> }
const MAX_TOTAL = 20 * 1024 * 1024;

const empty = (): ObmDocuments => ({ docs: Object.fromEntries(OBM_DOC_ITEMS.map((k) => [k, []])) as unknown as ObmDocuments['docs'] });
const schema = z.object({ docs: z.object(Object.fromEntries(OBM_DOC_ITEMS.map((k) => [k, z.array(z.unknown())]))).strict() }).strict();

export const obmDocumentsConfig = versionedConfig<ObmDocuments>({
  key: 'obm_documents_v1',
  action: 'OBM_DOCUMENTS',
  noun: 'the checklist documents',
  defaults: empty,
  merge: (saved) => ({ docs: { ...empty().docs, ...(saved?.docs ?? {}) } }),
  validate: (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ConfigError(400, 'The checklist documents could not be saved', ['One of the items has an invalid document list']);
    const out = empty();
    const problems: string[] = [];
    let total = 0;
    for (const k of OBM_DOC_ITEMS) {
      try {
        out.docs[k] = validateMasterMailAttachments(parsed.data.docs[k]);
        total += out.docs[k].reduce((s, f) => s + f.size, 0);
      } catch (e: any) { problems.push(`${OBM_DOC_LABELS[k]}: ${e.message}`); }
    }
    if (total > MAX_TOTAL) problems.push('All the documents together must be 20 MB or less');
    if (problems.length) throw new ConfigError(400, 'The checklist documents could not be saved', problems);
    return out;
  },
});

/** The documents that belong to the checklist items ticked on this lead. */
export async function obmDocumentRefs(tickedItems: string[]): Promise<MasterMailAttachment[]> {
  const { docs } = await obmDocumentsConfig.get();
  const seen = new Set<string>();
  return OBM_DOC_ITEMS.filter((k) => tickedItems.includes(k)).flatMap((k) => docs[k]).filter((f) => !seen.has(f.storagePath) && !!seen.add(f.storagePath));
}

export async function obmDocumentAttachments(tickedItems: string[]): Promise<EmailAttachment[]> {
  return downloadMasterMailAttachments(await obmDocumentRefs(tickedItems));
}
