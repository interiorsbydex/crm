import { randomUUID } from 'crypto';
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import { sendEmail, noShowNoPlanEmail } from '../lib/email.js';
import { saveDraft } from '../lib/emailService.js';
import { isLenientLaunch } from '../lib/lenientMode.js';
import { renderMailTemplate } from '../lib/mailTemplates.js';
import { notifyManagers } from '../lib/notifications.js';
import { sendSms } from '../services/smsService.js';
import { recalculateMilestones } from '../lib/milestones.js';
import { queues } from '../jobs/index.js';
import { getMeetingSettings } from '../lib/meetingSettings.js';
import { isAuthorizedForLead } from '../lib/leadAuth.js';
import { assertNextPlanMeetingSchedulable, createNextPlanRecords, runNextPlanMeetingSideEffects, sendNextPlanMails, validateNextPlanItems, type NextPlanItem } from '../lib/nextPlanOfAction.js';
import { assertAttachmentTypesMatch, validateAttachmentPairing } from '../lib/attachmentValidation.js';
import { computeMeetingNumbering, createMeetingRecord, runMeetingScheduledSideEffects, normalizeMeetingLocation } from '../lib/meetingScheduler.js';
import { meetingIdsScheduledByCre } from '../lib/creMeetingScope.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import { isAutomationOn, eventForDraftType } from '../lib/automations.js';
import { istDateTimeLabel } from '../lib/istTime.js';

// Selectable when scheduling a NEW meeting. DESIGN_FREEZE/SIGN_OFF remain valid
// enum values (and stay readable/reportable) for historical rows only — they
// are intentionally excluded here per Task #86.
const CREATABLE_MEETING_TYPES = ['DQL', 'PP', 'PD', 'ONBOARDING', 'OBM'];
// Kept in lockstep with client/src/components/tabs/MeetingsTab.tsx MOM_ATTACHMENT_TYPES.
const MOM_ATTACHMENT_TYPES = ['Floor Plan', 'Proposal', 'Lifestyle Sheet', 'Other'];
// Same private Supabase bucket used by the call-log attachment upload endpoint
// (server/src/routes/calls.ts) — MOM attachments reuse it via the same
// /leads/:leadId/calls/upload-attachment route.
const MOM_ATTACHMENTS_BUCKET = 'crm-call-attachments';
const VALID_MEETING_MODES = ['EC_VISIT', 'SITE_VISIT', 'VIRTUAL', 'PUBLIC_PLACE', 'CLIENT_PLACE'] as const;

async function hydrateMomAttachments<T extends { momAttachments: unknown }>(meeting: T): Promise<T> {
  const attachments = meeting.momAttachments as { type: string; storagePath?: string; fileUrl?: string }[] | null;
  if (!attachments?.length || !supabaseAdmin) return meeting;
  const hydrated = await Promise.all(
    attachments.map(async (att) => {
      if (!att.storagePath) return att; // legacy public URL — return as-is
      const { data, error } = await supabaseAdmin!.storage
        .from(MOM_ATTACHMENTS_BUCKET)
        .createSignedUrl(att.storagePath, 60 * 60); // 1-hour signed URL
      return { type: att.type, fileUrl: error ? undefined : data?.signedUrl };
    }),
  );
  return { ...meeting, momAttachments: hydrated };
}

export const meetingsRouter = Router({ mergeParams: true });
export const meetingStatusRouter = Router();

const meetingInclude = {
  lead: { select: { id: true, leadId: true, name: true, email: true } },
} as const;

// ── POST /api/leads/:leadId/meetings ─────────────────────────────────────────
meetingsRouter.post('/', verifyToken, async (req, res) => {
  const { leadId } = req.params as { leadId: string };
  const user = req.user!;

  const { type, mode, scheduledAt, location, notifyClient, bookingAttachments, internalNotes } = req.body as {
    type?: string;
    mode?: string;
    scheduledAt?: string;
    location?: string;
    // Mandatory "send externally?" checkbox — must be explicitly provided by the booking form.
    notifyClient?: boolean;
    // Optional documents attached at booking time (storagePaths from calls/upload-attachment).
    bookingAttachments?: { storagePath: string; fileName?: string }[];
    // Staff-only internal notes — never shared with the client.
    internalNotes?: string;
  };

  if (!type || !mode || !scheduledAt) {
    res.status(400).json({ error: 'type, mode, and scheduledAt are required' });
    return;
  }
  if (typeof notifyClient !== 'boolean') {
    res.status(400).json({ error: 'notifyClient must be true or false — confirm whether to email the client.' });
    return;
  }

  if (!CREATABLE_MEETING_TYPES.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${CREATABLE_MEETING_TYPES.join(', ')}` });
    return;
  }
  const meetingSettings = await getMeetingSettings();
  if (!VALID_MEETING_MODES.includes(mode as typeof VALID_MEETING_MODES[number]) || !meetingSettings.modes[mode as typeof VALID_MEETING_MODES[number]].active) {
    res.status(400).json({ error: `Pick one of the meeting types in use: ${VALID_MEETING_MODES.filter((m) => meetingSettings.modes[m].active).map((m) => meetingSettings.modes[m].label).join(', ')}` });
    return;
  }
  let normalizedLocation: string | undefined;
  try {
    normalizedLocation = normalizeMeetingLocation(location);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, leadId: true, name: true, email: true, phone: true, assignedDesignerId: true, assignedBLId: true, intentRating: true, intentRatingSource: true, status: true },
  });
  if (!lead) {
    res.status(404).json({ error: 'Lead not found' });
    return;
  }
  if (!(await isAuthorizedForLead(lead, user))) {
    res.status(403).json({ error: 'Not authorised to create meetings for this lead' });
    return;
  }
  if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

  // ── Duplicate-meeting guard ────────────────────────────────────────────────
  const activeMeeting = await prisma.meeting.findFirst({
    where: { leadId, status: 'SCHEDULED' },
    select: { id: true, type: true, scheduledAt: true },
  });
  if (activeMeeting) {
    const activeDate = new Date(activeMeeting.scheduledAt).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit',
    });
    res.status(409).json({
      error: `A ${activeMeeting.type} meeting is already scheduled for ${activeDate}. Reschedule or mark no-show before creating a new one.`,
    });
    return;
  }

  const { ppNumber } = await computeMeetingNumbering(leadId, type);
  const meeting = await createMeetingRecord(prisma, { leadId, type, mode, scheduledAt, location: normalizedLocation, ppNumber, internalNotes });

  // Persist any pre-meeting documents uploaded at booking time
  if (bookingAttachments && bookingAttachments.length > 0) {
    await prisma.meeting.update({
      where: { id: meeting.id },
      data: { bookingAttachments },
    });
  }

  const pendingMail = await runMeetingScheduledSideEffects({
    meeting,
    lead: { id: lead.id, leadId: lead.leadId, name: lead.name, email: lead.email, phone: lead.phone, assignedDesignerId: lead.assignedDesignerId, assignedBLId: lead.assignedBLId },
    user,
    type,
    mode,
    scheduledAt,
    ppNumber,
    notifyClient,
    bookingAttachments,
  });

  res.status(201).json({ meeting, pendingMail });
});

// ── GET /api/meetings — role-scoped global view ───────────────────────────────
meetingStatusRouter.get('/', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    let where: any = {};

    if (user.role === 'DESIGNER') {
      where.lead = { assignedDesignerId: user.id };
    } else if (user.role === 'CRE') {
      where.lead = { OR: [{ assignedCREId: user.id }, { assignedDesignerId: user.id }, { createdById: user.id }] };
    } else if (user.role === 'BL') {
      const members = await prisma.user.findMany({
        where: { blId: user.id },
        select: { id: true },
      });
      where.lead = { OR: [
        { assignedBLId: user.id },
        { assignedDesignerId: { in: members.map((m: any) => m.id) } },
      ] };
    }
    // BRANCH_HEAD: no filter = all meetings

    const meetings = await prisma.meeting.findMany({
      where,
      include: {
        lead: {
          select: {
            id: true, leadId: true, name: true, phone: true,
            assignedDesigner: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
    });

    if (meetings.length === 0) {
      res.json({ meetings: [] }); return;
    }

    // Meeting rows don't store the scheduler. The scheduling activity records
    // do, so include only rows booked by a CRE (not all meetings on CRE-owned
    // leads). A reschedule creates a new meeting row with its own booking actor.
    const activities = await prisma.activityLog.findMany({
      where: {
        leadId: { in: [...new Set(meetings.map((meeting) => meeting.leadId))] },
        action: { in: ['MEETING_SCHEDULED', 'MEETING_RESCHEDULED'] },
      },
      select: { action: true, meta: true, user: { select: { role: true } } },
    });
    const creMeetingIds = meetingIdsScheduledByCre(activities);
    const creMeetings = meetings.filter((meeting) => creMeetingIds.has(meeting.id));
    res.json({ meetings: await Promise.all(creMeetings.map(hydrateMomAttachments)) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/:leadId/meetings ──────────────────────────────────────────
meetingsRouter.get('/', verifyToken, async (req, res) => {
  const { leadId } = req.params as { leadId: string };
  const user = req.user!;

  // Lead-scope authorization
  const scopeLead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, assignedDesignerId: true, assignedBLId: true },
  });
  if (!scopeLead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (!(await isAuthorizedForLead(scopeLead, user))) {
    res.status(403).json({ error: 'Not authorised to view meetings for this lead' });
    return;
  }

  const rawMeetings = await prisma.meeting.findMany({
    where: { leadId },
    include: meetingInclude,
    orderBy: { scheduledAt: 'desc' },
  });

  // Compute per-type sequence numbers (1-based, by creation order).
  // RESCHEDULED meetings are excluded from the counter so that a DQL which
  // was rescheduled once still appears as "DQL 1" (not "DQL 2") in the UI.
  // The RESCHEDULED record itself receives the same seqNumber as the active
  // replacement (they share the same conceptual meeting identity).
  const activeByType = new Map<string, number>();  // non-RESCHEDULED counter
  const seqById = new Map<string, number>();

  const sortedActive = [...rawMeetings]
    .filter((m) => m.status !== 'RESCHEDULED')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  sortedActive.forEach((m) => {
    const n = (activeByType.get(m.type) ?? 0) + 1;
    activeByType.set(m.type, n);
    seqById.set(m.id, n);
  });

  // For RESCHEDULED records: assign seqNumber based on creation order among all
  // meetings of that type (their original scheduled slot).
  const sortedAll = [...rawMeetings].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const allByType = new Map<string, number>();
  sortedAll.forEach((m) => {
    const n = (allByType.get(m.type) ?? 0) + 1;
    allByType.set(m.type, n);
    if (!seqById.has(m.id)) seqById.set(m.id, n); // only sets for RESCHEDULED records
  });

  const meetings = await Promise.all(
    rawMeetings.map(async (m) => ({ ...(await hydrateMomAttachments(m)), seqNumber: seqById.get(m.id) ?? 1 })),
  );

  res.json({ meetings });
});

// ── POST /api/leads/:leadId/meetings/log ─────────────────────────────────────
// "Log Meeting": record a meeting that has already happened (like Log Call),
// saved straight as COMPLETED. Nothing is sent to the client.
meetingsRouter.post('/log', verifyToken, async (req, res) => {
  const { leadId } = req.params as { leadId: string };
  const user = req.user!;
  const { type, mode, heldAt, location, mom, internalNotes } = req.body as {
    type?: string; mode?: string; heldAt?: string; location?: string; mom?: string; internalNotes?: string;
  };

  if (!type || !CREATABLE_MEETING_TYPES.includes(type)) {
    res.status(400).json({ error: `Pick the meeting: one of ${CREATABLE_MEETING_TYPES.join(', ')}` });
    return;
  }
  const meetingSettings = await getMeetingSettings();
  if (!mode || !VALID_MEETING_MODES.includes(mode as typeof VALID_MEETING_MODES[number]) || !meetingSettings.modes[mode as typeof VALID_MEETING_MODES[number]].active) {
    res.status(400).json({ error: `Pick where it happened: ${VALID_MEETING_MODES.filter((m) => meetingSettings.modes[m].active).map((m) => meetingSettings.modes[m].label).join(', ')}` });
    return;
  }
  const held = heldAt ? new Date(heldAt) : null;
  if (!held || isNaN(held.getTime())) {
    res.status(400).json({ error: 'When did the meeting happen? Date and time are required' });
    return;
  }
  if (held.getTime() > Date.now() + 5 * 60_000) {
    res.status(400).json({ error: 'A logged meeting must already have happened. For a future meeting, use Schedule Meeting' });
    return;
  }
  if (meetingSettings.requireMom && !mom?.trim()) {
    res.status(400).json({ error: 'Minutes of Meeting are required' });
    return;
  }
  let normalizedLocation: string | undefined;
  try {
    normalizedLocation = normalizeMeetingLocation(location);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
    return;
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, assignedDesignerId: true, assignedBLId: true, status: true },
  });
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (!(await isAuthorizedForLead(lead, user))) {
    res.status(403).json({ error: 'Not authorised to log meetings for this lead' });
    return;
  }
  if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

  const { ppNumber } = await computeMeetingNumbering(leadId, type);
  const created = await createMeetingRecord(prisma, { leadId, type, mode, scheduledAt: held.toISOString(), location: normalizedLocation, ppNumber, internalNotes });
  const meeting = await prisma.meeting.update({
    where: { id: created.id },
    data: { status: 'COMPLETED', mom: mom?.trim() || null, momSent: false },
    include: meetingInclude,
  });

  await logActivity(user.id, 'MEETING_LOGGED', leadId, { meetingId: meeting.id, type, mode, scheduledAt: held.toISOString(), mom: mom?.trim() || undefined });
  await recalculateMilestones(leadId);

  res.status(201).json({ meeting });
});

// ── PATCH /api/meetings/:id/status ───────────────────────────────────────────
meetingStatusRouter.patch('/:id/status', verifyToken, async (req, res) => {
  const { id } = req.params;
  const user = req.user!;

  const {
    status, mom, rescheduledReason, rescheduleMode, rescheduleLocation, noShowReason, outcome, newScheduledAt, replanScheduledAt, replanMode, replanLocation,
    momAttachmentTypes, momAttachments, nextPlanOfAction,
  } = req.body as {
    status?: string;
    mom?: string;
    rescheduledReason?: string;
    rescheduleMode?: string;
    rescheduleLocation?: string;
    noShowReason?: string;
    outcome?: string;
    newScheduledAt?: string;
    replanScheduledAt?: string;
    replanMode?: string;
    replanLocation?: string;
    momAttachmentTypes?: string[];
    momAttachments?: { type: string; storagePath?: string; fileUrl?: string }[];
    nextPlanOfAction?: NextPlanItem[];
    // Gates the NPS survey email fired on completion. Onboarding meetings
    // require this to be explicitly enabled; other supported triggers remain
    // optional.
    sendNpsSurvey?: boolean;
  };

  const validStatuses = ['COMPLETED', 'RESCHEDULED', 'NO_SHOW'];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  let normalizedRescheduleMode: string | undefined;
  let normalizedRescheduleLocation: string | undefined;
  let normalizedReplanMode: string | undefined;
  let normalizedReplanLocation: string | undefined;

  // Which details are mandatory: Admin → Meetings.
  const meetingRules = await getMeetingSettings();
  const modeInUse = (m: string | undefined) => !!m && VALID_MEETING_MODES.includes(m as typeof VALID_MEETING_MODES[number]) && meetingRules.modes[m as typeof VALID_MEETING_MODES[number]].active;
  if (status === 'COMPLETED') {
    if (meetingRules.requireMom && !mom?.trim()) {
      res.status(400).json({ error: 'mom (Minutes of Meeting) is required when marking COMPLETED' });
      return;
    }
    if (momAttachmentTypes?.some((t) => !MOM_ATTACHMENT_TYPES.includes(t))) {
      res.status(400).json({ error: `momAttachmentTypes must be a subset of: ${MOM_ATTACHMENT_TYPES.join(', ')}` });
      return;
    }
    // Task #115 — multiple files per category are allowed; momAttachmentTypes
    // may repeat a category once per file attached under it.
    try {
      validateAttachmentPairing(momAttachments, MOM_ATTACHMENT_TYPES, 'momAttachments');
      assertAttachmentTypesMatch(momAttachmentTypes, momAttachments, 'momAttachmentTypes');
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
  }
  if (status === 'COMPLETED' && nextPlanOfAction?.length) {
    try {
      validateNextPlanItems(nextPlanOfAction);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
  }
  if (status === 'RESCHEDULED' && meetingRules.requireRescheduleReason && !rescheduledReason?.trim()) {
    res.status(400).json({ error: 'rescheduledReason is required when marking RESCHEDULED' });
    return;
  }
  if (status === 'RESCHEDULED') {
    if (!newScheduledAt || isNaN(new Date(newScheduledAt).getTime())) {
      res.status(400).json({ error: 'newScheduledAt (new date & time) is required when rescheduling' });
      return;
    }
    if (new Date(newScheduledAt).getTime() <= Date.now()) {
      res.status(400).json({ error: 'The new meeting date and time must be in the future' });
      return;
    }
    if (!modeInUse(rescheduleMode)) {
      res.status(400).json({ error: `rescheduleMode must be one of: ${VALID_MEETING_MODES.join(', ')}` });
      return;
    }
    normalizedRescheduleMode = rescheduleMode;
    try {
      normalizedRescheduleLocation = normalizeMeetingLocation(rescheduleLocation, 'rescheduleLocation');
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!normalizedRescheduleLocation) {
      res.status(400).json({ error: 'rescheduleLocation is required when rescheduling' });
      return;
    }
  }
  if (status === 'NO_SHOW') {
    if (meetingRules.requireNoShowReason && !noShowReason?.trim()) {
      res.status(400).json({ error: 'noShowReason is required when marking NO_SHOW' });
      return;
    }
    if (!replanScheduledAt || isNaN(new Date(replanScheduledAt).getTime())) {
      res.status(400).json({ error: 'replanScheduledAt (next tentative date & time) is required when marking NO_SHOW' });
      return;
    }
    if (!modeInUse(replanMode)) {
      res.status(400).json({ error: `replanMode must be one of: ${VALID_MEETING_MODES.join(', ')}` });
      return;
    }
    normalizedReplanMode = replanMode;
    try {
      normalizedReplanLocation = normalizeMeetingLocation(replanLocation, 'replanLocation');
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!normalizedReplanLocation) {
      res.status(400).json({ error: 'replanLocation is required when marking NO_SHOW' });
      return;
    }
  }

  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: { lead: true },
  });
  if (!meeting) {
    res.status(404).json({ error: 'Meeting not found' });
    return;
  }

  // Lead-scope authorization
  if (!(await isAuthorizedForLead(meeting.lead, user))) {
    res.status(403).json({ error: 'Not authorised to update this meeting' });
    return;
  }
  if (isLeadLocked(meeting.lead.status)) { sendLeadLockedError(res); return; }

  // Enforce valid source status — only SCHEDULED meetings can be transitioned
  if (meeting.status !== 'SCHEDULED') {
    res.status(400).json({ error: `Cannot change status of a meeting that is already ${meeting.status}` });
    return;
  }

  const lead = meeting.lead;
  const isOnboardingMeeting = meeting.type === 'ONBOARDING' || meeting.type === 'OBM';

  // Lenient launch: a meeting with no client email on file can still be recorded
  // (the MOM / NPS mails are simply not drafted). Onboarding meetings keep the
  // requirement because their NPS survey cannot be sent without an address.
  if (status === 'COMPLETED' && !lead.email?.trim() && (isOnboardingMeeting || !isLenientLaunch())) {
    res.status(400).json({ error: 'A client email is required before a completed meeting can be recorded' });
    return;
  }

  // ── RESCHEDULED: atomic archive + replacement creation ───────────────────────
  let updated: any;
  let replacementMeeting: any = null;
  let nextPlanMeetingPendingMail: Awaited<ReturnType<typeof runNextPlanMeetingSideEffects>> = null;

  if (status === 'RESCHEDULED') {
    const previousHistory = (meeting.rescheduleHistory as any[]) ?? [];
    const archiveData = {
      status: 'RESCHEDULED' as const,
      outcome,
      rescheduledReason,
      rescheduleHistory: [
        ...previousHistory,
        {
          scheduledAt: meeting.scheduledAt.toISOString(),
          reason: rescheduledReason,
          rescheduledAt: new Date().toISOString(),
        },
      ],
    };

    const txResult = await prisma.$transaction(async (tx) => {
      const archived = await tx.meeting.update({
        where: { id },
        data: archiveData,
        include: meetingInclude,
      });
      const replacement = await tx.meeting.create({
        data: {
          leadId: lead.id,
          type: meeting.type as any,
           mode: normalizedRescheduleMode! as any,
           location: normalizedRescheduleLocation,
          ppNumber: meeting.ppNumber,
          scheduledAt: new Date(newScheduledAt!),
          confirmationSent: true,
          // Carry forward the full prior chain (mirrors the task reschedule
          // pattern) so the active meeting always reflects every reschedule,
          // not just the one that just happened.
          rescheduleHistory: archiveData.rescheduleHistory,
        },
        include: meetingInclude,
      });
      await tx.activityLog.create({
        data: {
          userId: user.id,
          action: 'MEETING_RESCHEDULED',
          leadId: lead.id,
          meta: {
            originalMeetingId: id,
            replacementMeetingId: replacement.id,
            scheduledByRole: user.role,
            rescheduledReason,
            rescheduleMode: normalizedRescheduleMode,
            rescheduleLocation: normalizedRescheduleLocation,
            oldDate: meeting.scheduledAt.toISOString(),
            newDate: new Date(newScheduledAt!).toISOString(),
          },
        },
      });
      return { archived, replacement };
    });

    updated = txResult.archived;
    replacementMeeting = txResult.replacement;
  } else {
    // ── COMPLETED / NO_SHOW ──────────────────────────────────────────────────
    const updateData: any = { status, outcome };
    if (status === 'COMPLETED') {
      updateData.mom = mom;
      updateData.momAttachmentTypes = momAttachmentTypes?.length ? momAttachmentTypes : undefined;
      updateData.momAttachments = momAttachments?.length ? momAttachments : undefined;
      updateData.nextPlanOfActionItems = nextPlanOfAction?.length ? nextPlanOfAction : undefined;
      // No MOM written (allowed when Admin → Meetings makes it optional) means no MOM mail either.
      updateData.momSent = !!mom?.trim();
    }
    if (status === 'NO_SHOW') {
      updateData.noShowReason = noShowReason?.trim() || null;
      updateData.replanScheduledAt = new Date(replanScheduledAt!);
      updateData.replanMode = normalizedReplanMode!;
      updateData.replanLocation = normalizedReplanLocation!;
    }

    // A next-plan MEETING item created from MOM completion must obey the same
    // single-active-meeting guard/numbering as any other scheduler entry point.
    // The meeting being completed here is about to leave SCHEDULED status, so
    // it's excluded from the "active meeting" check by virtue of this update
    // running first inside the same transaction below.
    let nextPlanMeetingPpNumber: number | null = null;
    let nextPlanMeetingPendingMail: Awaited<ReturnType<typeof runNextPlanMeetingSideEffects>> = null;
    if (status === 'COMPLETED' && nextPlanOfAction?.length) {
      try {
        // Exclude the meeting being completed itself — it is still SCHEDULED
        // at this read (its own status flips to COMPLETED later, inside the
        // transaction below), so without this exclusion the check would
        // always see it and incorrectly reject every next-plan meeting.
        nextPlanMeetingPpNumber = await assertNextPlanMeetingSchedulable(nextPlanOfAction, lead.id, id);
      } catch (err: any) {
        res.status(409).json({ error: err.message });
        return;
      }
    }

    // MOM completion + its "next plan of action" batch are committed atomically:
    // if any next-plan item fails to create, the meeting-completion update
    // itself rolls back too, instead of reporting success on a partial plan.
    let nextPlanMeeting: Awaited<ReturnType<typeof createNextPlanRecords>>['meetingCreated'] = null;
    updated = await prisma.$transaction(async (tx) => {
      const meetingUpdate = await tx.meeting.update({
        where: { id },
        data: updateData,
        include: meetingInclude,
      });
      if (status === 'COMPLETED' && nextPlanOfAction?.length) {
        ({ meetingCreated: nextPlanMeeting } = await createNextPlanRecords(tx, nextPlanOfAction, {
          leadId: lead.id, userId: user.id, userRole: user.role, meetingPpNumber: nextPlanMeetingPpNumber,
        }));
      }
      return meetingUpdate;
    });

    if (nextPlanMeeting) {
      nextPlanMeetingPendingMail = await runNextPlanMeetingSideEffects(
        nextPlanMeeting,
        { id: lead.id, leadId: lead.leadId, name: lead.name, email: lead.email, phone: lead.phone, assignedDesignerId: lead.assignedDesignerId, assignedBLId: lead.assignedBLId },
        user,
      );
    }
  }

  // Best-effort per-item client mail — only fired once the transaction above
  // has committed, so a mail failure never rolls back a persisted plan.
  if (status === 'COMPLETED' && nextPlanOfAction?.length) {
    await sendNextPlanMails(nextPlanOfAction, { id: lead.id, name: lead.name, email: lead.email });
  }

  // Client-facing mail (MOM / reschedule / no-show) is drafted here but not
  // auto-sent — it's saved as an editable draft the designer must open and
  // explicitly click Send on (client/src/components/tabs/MeetingsTab.tsx),
  // reusing the same draft/send-draft endpoints (routes/email.ts) as the
  // PD→OB Welcome Mail pattern. `pendingMail` in the response carries the
  // prefilled content the client needs to open that review step.
  let pendingMail: { draftKey: string; type: string; to: string; subject: string; html: string } | undefined;
  if (lead.email) {
    let emailPayload;

    if (status === 'COMPLETED' && mom?.trim()) {
      // Download the actual file bytes so they ride along as real email
      // attachments (not just a link) — per the client's ask that "the email
      // should also have the attachment attached".
      //
      // Exception: the DQL meeting's completion mail is the "PR" (Proposal
      // Ready) mail — presentation + quotation — and must never carry an
      // attachment, regardless of what the designer attached to the MOM.
      // Every other meeting type (PP included) keeps the existing
      // designer's-choice attachment behavior.
      const isPrMail = meeting.type === 'DQL';
      const momEmailAttachments: { filename: string; content: string; contentType?: string }[] = [];
      if (!isPrMail && momAttachments?.length && supabaseAdmin) {
        for (const att of momAttachments) {
          if (!att.storagePath) continue;
          const { data, error } = await supabaseAdmin.storage
            .from(MOM_ATTACHMENTS_BUCKET)
            .download(att.storagePath);
          if (error || !data) {
            console.warn(`[meetings:mom-email] Could not download attachment ${att.storagePath}: ${error?.message}`);
            continue;
          }
          const buffer = Buffer.from(await data.arrayBuffer());
          const originalName = att.storagePath.split('/').pop() ?? att.type;
          momEmailAttachments.push({
            filename: `${att.type} - ${originalName}`,
            content: buffer.toString('base64'),
            contentType: data.type || undefined,
          });
        }
      }
      const attachmentsHtml = momEmailAttachments.length
        ? `<p><strong>Attachments:</strong> ${momEmailAttachments.length} file(s) attached to this email.</p>`
        : '';
      const rendered = await renderMailTemplate('MOM', {
        clientName: lead.name,
        meetingType: meeting.ppNumber ? `PP${meeting.ppNumber}` : meeting.type,
        scheduledAt: istDateTimeLabel(meeting.scheduledAt, { weekday: true }),
        mom: mom!.replace(/\n/g, '<br/>'),
        attachmentsHtml,
      });
      emailPayload = { to: '', subject: rendered.subject, html: rendered.html, attachments: momEmailAttachments.length ? momEmailAttachments : undefined };
    } else if (status === 'RESCHEDULED') {
      const rendered = await renderMailTemplate('RESCHEDULED', {
        clientName: lead.name,
        reason: rescheduledReason?.trim() || '—',
      });
      emailPayload = { to: '', subject: rendered.subject, html: rendered.html };
    } else if (status === 'NO_SHOW') {
      const rendered = await renderMailTemplate('NO_SHOW', { clientName: lead.name });
      emailPayload = { to: '', subject: rendered.subject, html: rendered.html };
    }

    // Admin → Automations can switch this client email off.
    if (emailPayload && !(await isAutomationOn(eventForDraftType(`MEETING_${status}`), 'email'))) emailPayload = null;
    if (emailPayload) {
      emailPayload.to = lead.email;
      const type = `MEETING_${status}`;
      const draftKey = `${lead.id}::${type}`;
      await saveDraft(draftKey, emailPayload.subject, emailPayload.html, { leadId: lead.id, type }, (emailPayload as any).attachments);
      pendingMail = { draftKey, type, to: emailPayload.to, subject: emailPayload.subject, html: emailPayload.html };
    }
  }

  // SMS: status-triggered messages (each can be switched off in Admin → Automations)
  const smsEvent = eventForDraftType(`MEETING_${status}`);
  if (lead.phone && ['MOM', 'RESCHEDULED', 'NO_SHOW'].includes(smsEvent) && await isAutomationOn(smsEvent, 'sms')) {
    if (status === 'COMPLETED' && mom?.trim()) {
      sendSms(
        lead.phone,
        `Hi ${lead.name}, your meeting summary (MOM) has been emailed to you. - Interiors by DeX`,
        lead.id,
      ).catch((e) => console.warn('[meetings:sms:mom]', e.message));
    } else if (status === 'RESCHEDULED') {
      const newTime = new Date(newScheduledAt!).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
      });
      sendSms(
        lead.phone,
        `Hi ${lead.name}, your meeting has been rescheduled to ${newTime}. Reason: ${rescheduledReason}. - Interiors by DeX`,
        lead.id,
      ).catch((e) => console.warn('[meetings:sms:rescheduled]', e.message));
    } else if (status === 'NO_SHOW') {
      sendSms(
        lead.phone,
        `Hi ${lead.name}, we missed you at today's meeting. Please reply with your available times and we'll reschedule. - Interiors by DeX`,
        lead.id,
      ).catch((e) => console.warn('[meetings:sms:no_show]', e.message));
    }
  }

  // In-app notification + email for NO_SHOW — enhanced when no follow-up meeting is planned
  if (status === 'NO_SHOW') {
    const plannedMeeting = await prisma.meeting.findFirst({
      where: { leadId: lead.id, status: 'SCHEDULED' },
      select: { id: true },
    });
    // A captured replan date/time/location on this record counts as a plan too.
    const hasNoPlan = !plannedMeeting && !replanScheduledAt;
    const noShowMsg = hasNoPlan
      ? `⚠ Client ${lead.name} (${lead.leadId}) was a no-show for the ${meeting.type} meeting and has NO follow-up meeting scheduled. Immediate action required.`
      : `Client ${lead.name} (${lead.leadId}) was a no-show for the ${meeting.type} meeting.`;

    // In-app notifications
    if (lead.assignedBLId) {
      await createNotification(lead.assignedBLId, 'MEETING_NO_SHOW', noShowMsg, lead.id, meeting.scheduledAt);
    }
    await notifyManagers('MEETING_NO_SHOW', noShowMsg, lead.id, meeting.scheduledAt);

    // Send email to BL + managers when no follow-up plan exists
    if (hasNoPlan) {
      const recipients: { name: string; email: string }[] = [];
      if (lead.assignedBLId) {
        const bl = await prisma.user.findUnique({ where: { id: lead.assignedBLId }, select: { name: true, email: true } });
        if (bl?.email) recipients.push(bl);
      }
      const managers = await prisma.user.findMany({
        where: { role: { in: ['BRANCH_HEAD'] }, isActive: true },
        select: { name: true, email: true },
      });
      for (const mgr of managers) { if (mgr.email) recipients.push(mgr); }

      for (const recipient of recipients) {
        const emailPayload = noShowNoPlanEmail({
          recipientName: recipient.name,
          leadId: lead.leadId,
          leadName: lead.name,
          meetingType: meeting.type,
          noShowReason: noShowReason?.trim() || '—',
        });
        emailPayload.to = recipient.email!;
        if (await isAutomationOn('TEAM_NO_SHOW_NO_PLAN', 'email')) queues.emails.add('no-show-no-plan', { emailPayload, leadId: lead.id }).catch(() => {});
      }
    }
  }

  // Log activity — RESCHEDULED already logged inside the reschedule block above
  if (status !== 'RESCHEDULED') {
    await logActivity(user.id, `MEETING_${status}`, lead.id, {
      meetingId: id,
      mom,
    });
  }

  await recalculateMilestones(lead.id);

  res.json({
    meeting: updated,
    replacementMeeting: replacementMeeting ?? undefined,
    pendingMail,
    nextPlanPendingMail: nextPlanMeetingPendingMail ?? undefined,
    // NPS is prepared from the OB→OBM checklist, not again on meeting completion.
    npsPendingMail: undefined,
  });
});
