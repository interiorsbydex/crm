export function requiredDipChecksComplete(checklist: {
  cxApprovalReceived: boolean;
  internalMailThreadCompleted: boolean;
}): boolean {
  return checklist.cxApprovalReceived && checklist.internalMailThreadCompleted;
}
