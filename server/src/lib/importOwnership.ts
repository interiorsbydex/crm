/** Historical ownership is source data, not a request to find a replacement. */
export type ImportStaff = { id: string; name: string; role: string };
export type ImportOwnerFields = {
  designerName?: string; blName?: string; creName?: string; ownerName?: string;
};

export function resolveImportOwnership(
  fields: ImportOwnerFields,
  staff: ImportStaff[],
  stage: string,
  status: string,
) {
  const issues: string[] = [];
  const names: string[] = [];
  const lookup = (value: string | undefined, roles: string[], label: string) => {
    if (!value?.trim()) return undefined;
    const matches = staff.filter((u) =>
      roles.includes(u.role) && u.name.trim().toLowerCase() === value.trim().toLowerCase());
    if (matches.length !== 1) {
      issues.push(`${label} "${value.trim()}" ${matches.length ? 'matches multiple users' : 'was not found'}`);
      return undefined;
    }
    names.push(`${label}: ${matches[0].name}`);
    return matches[0];
  };
  const designer = lookup(fields.designerName, ['DESIGNER', 'CRE'], 'Designer');
  const bl = lookup(fields.blName, ['BL'], 'BL');
  const cre = lookup(fields.creName, ['CRE'], 'CRE');
  let assignedDesignerId = designer?.id;
  let assignedCREId = cre?.id ?? (designer?.role === 'CRE' ? designer.id : undefined);
  if (designer?.role === 'CRE' && cre && designer.id !== cre.id) {
    issues.push('Designer Name and CRE Name identify different CRE owners; neither CRE was selected');
    assignedDesignerId = undefined;
    assignedCREId = undefined;
  }
  // An unlabeled owner could be BL, Designer or CRE. Do not infer a role or
  // silently discard the supplied historical name and allocate someone else.
  if (fields.ownerName?.trim()) {
    issues.push(`Owner "${fields.ownerName.trim()}" needs an explicit Designer Name, BL Name or CRE Name column`);
  }
  // Preserve the existing CRE scope compatibility for a CRE-only owner.
  if (!fields.designerName?.trim() && cre) assignedDesignerId = cre.id;
  const supplied = Object.values(fields).some((v) => !!v?.trim());
  const allocationEligible = !supplied && stage === 'EFFECTIVE_LEAD' && status === 'ACTIVE';
  const outcome = issues.length || (!supplied && !allocationEligible)
    ? 'MANUAL_REVIEW' as const : supplied ? 'PRESERVED' as const : 'ALLOCATION_PENDING' as const;
  const reason = issues.length
    ? `Ownership needs manual review: ${issues.join('; ')}. Valid matched fields are retained; no automatic replacement.`
    : supplied
      ? `Historical ownership preserved (${names.join('; ')}). No automatic replacement.`
      : allocationEligible
        ? 'Ownerless Active Effective Lead: CRE allocation is checked on confirmation; preview does not allocate.'
        : `Unassigned — manual ownership review. Automatic import allocation applies only to ownerless Active Effective Leads (${status}, ${stage}).`;
  return {
    assignedDesignerId, assignedBLId: bl?.id, assignedCREId,
    allocationEligible, outcome, reason, issues,
  };
}
