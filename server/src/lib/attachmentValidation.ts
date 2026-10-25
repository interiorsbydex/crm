/**
 * Shared validation for the "select category, then attach a file" pattern
 * used by call attachments, meeting MOM attachments, and follow-up task
 * attachments. Each selected category must be paired with an uploaded file
 * (a non-empty `storagePath` or `fileUrl`) — without this check the client
 * can submit more category selections than files actually uploaded,
 * producing attachment records with neither field set that can never
 * resolve to a signed URL, silently losing the "attachment" the user
 * thought they added.
 *
 * Task #115 — multiple files per category are allowed (the "exactly one
 * file per category" cap this module previously enforced was a deliberate
 * MVP restriction, not a data-model limit; the underlying field has always
 * been a JSON array of entries).
 */
export interface AttachmentEntry {
  type: string;
  storagePath?: string;
  fileUrl?: string;
}

/**
 * Validates that a "selected categories" list (e.g. `momAttachmentTypes`)
 * and an independently-submitted attachments array represent the exact same
 * multiset of categories — same count, same types. Without this check a
 * client (or a direct API call) can select a category with no corresponding
 * attachment, or attach a file under a category never selected, silently
 * breaking the one-file-per-category guarantee `validateAttachmentPairing`
 * otherwise enforces on the attachments array alone.
 */
export function assertAttachmentTypesMatch(
  selectedTypes: string[] | undefined,
  attachments: AttachmentEntry[] | undefined,
  label: string,
): void {
  const selected = [...(selectedTypes ?? [])].sort();
  const attached = [...(attachments ?? [])].map((a) => a.type).sort();
  if (selected.length !== attached.length || selected.some((t, i) => t !== attached[i])) {
    throw new Error(
      `${label}: selected categories must exactly match the attached files, one file per category (selected: ${selected.join(', ') || 'none'}; attached: ${attached.join(', ') || 'none'})`,
    );
  }
}

/**
 * Task #115 — follow-up tasks (created standalone or from a call outcome)
 * accept attachments too, but without a fixed category allow-list (unlike
 * calls/meetings) since no specific categories were specified for tasks.
 * Only presence of an uploaded file is enforced.
 */
export function validateGenericAttachments(attachments: AttachmentEntry[] | undefined, label: string): void {
  if (!attachments?.length) return;
  attachments.forEach((att, i) => {
    if (!att.type?.trim()) {
      throw new Error(`${label} item #${i + 1}: type is required`);
    }
    if (!att.storagePath?.trim() && !att.fileUrl?.trim()) {
      throw new Error(`${label} item #${i + 1} (${att.type}): a file must be uploaded before it can be attached — storagePath or fileUrl is required`);
    }
  });
}

export function validateAttachmentPairing(
  attachments: AttachmentEntry[] | undefined,
  allowedTypes: readonly string[],
  label: string,
): void {
  if (!attachments?.length) return;

  attachments.forEach((att, i) => {
    if (!att.type || !allowedTypes.includes(att.type)) {
      throw new Error(`${label} item #${i + 1}: type must be one of ${allowedTypes.join(', ')}`);
    }
    if (!att.storagePath?.trim() && !att.fileUrl?.trim()) {
      throw new Error(`${label} item #${i + 1} (${att.type}): a file must be uploaded before it can be attached — storagePath or fileUrl is required`);
    }
  });
}
