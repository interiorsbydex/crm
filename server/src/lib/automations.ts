/**
 * Automations (Admin → Automations): which automatic messages the CRM sends,
 * on which channels, and who is copied on client emails.
 *
 * Every place that sends (or prepares a draft of) an automatic message asks
 * isAutomationOn(event, channel) first. Client-email copies are added when the
 * email actually goes out (emailService.sendDraft / direct sends) by
 * automationCc(). In-app notifications are not affected by these switches.
 *
 * With nothing saved, every event is on with all its channels — the CRM's
 * behaviour before this setting existed — and the call emails copy the
 * designer, BL and Branch Heads, as their review screens already promised.
 */
import { z } from 'zod';
import { prisma } from './prisma.js';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';

export type Channel = 'email' | 'sms' | 'whatsapp';
export type CcRole = 'designer' | 'bl' | 'cre' | 'branchHeads';
export const CC_ROLES: { role: CcRole; label: string }[] = [
  { role: 'designer', label: 'Designer' },
  { role: 'bl', label: 'Business Lead' },
  { role: 'cre', label: 'CRE' },
  { role: 'branchHeads', label: 'Branch Heads' },
];

export interface AutomationEvent {
  code: string;
  label: string;
  /** When it fires, in plain words. */
  when: string;
  audience: 'client' | 'team';
  channels: Channel[];
  /** Emails a person reviews before sending (vs. sent automatically). */
  reviewed?: boolean;
  /** Can't be switched off, and why. */
  lockedReason?: string;
}

export const AUTOMATION_EVENTS: AutomationEvent[] = [
  // ── Messages to clients ──
  { code: 'MEETING_CONFIRMATION', label: 'Meeting booked', when: 'A meeting is scheduled', audience: 'client', channels: ['email', 'sms'], reviewed: true },
  { code: 'MEETING_REMINDER', label: 'Meeting reminder', when: 'Shortly before a meeting (timing in CRM Settings)', audience: 'client', channels: ['email'] },
  { code: 'RESCHEDULED', label: 'Meeting rescheduled', when: 'A meeting is moved to a new time', audience: 'client', channels: ['email', 'sms'], reviewed: true },
  { code: 'NO_SHOW', label: 'Missed meeting', when: 'A meeting is marked No-show', audience: 'client', channels: ['email', 'sms'], reviewed: true },
  { code: 'MOM', label: 'Minutes of meeting', when: 'A meeting is marked Completed', audience: 'client', channels: ['email', 'sms'], reviewed: true },
  { code: 'CALL_LOG_SUMMARY', label: 'Call summary', when: 'A call is logged as Answered', audience: 'client', channels: ['email'], reviewed: true },
  { code: 'CALL_SCHEDULED', label: 'Call scheduled', when: 'An external call is scheduled', audience: 'client', channels: ['email'], reviewed: true },
  { code: 'EXTERNAL_TASK', label: 'Follow-up scheduled', when: 'An external follow-up is scheduled', audience: 'client', channels: ['email', 'whatsapp'], reviewed: true },
  { code: 'CALL_RESCHEDULED', label: 'Follow-up rescheduled', when: 'An external follow-up or call is moved', audience: 'client', channels: ['email', 'whatsapp'], reviewed: true },
  { code: 'TASK_REMINDER', label: 'Follow-up reminder', when: 'Shortly before an external follow-up', audience: 'client', channels: ['email'] },
  { code: 'NEXT_PLAN_OF_ACTION', label: 'Next steps', when: 'A next step is flagged "send to client"', audience: 'client', channels: ['email'] },
  { code: 'PROPOSAL_READY', label: 'Proposal ready', when: 'A lead reaches Proposal Ready', audience: 'client', channels: ['email'], reviewed: true },
  { code: 'WEEKLY_DIGEST', label: 'Weekly schedule', when: 'On the weekly digest day (CRM Settings)', audience: 'client', channels: ['email'], reviewed: true },
  { code: 'ON_HOLD', label: 'Project on hold', when: 'A lead is put On Hold', audience: 'client', channels: ['email', 'sms', 'whatsapp'], reviewed: true },
  { code: 'INACTIVATION_FEEDBACK', label: 'Feedback request on closing', when: 'A lead is marked Inactive', audience: 'client', channels: ['email', 'sms'], reviewed: true },
  { code: 'REACTIVATION', label: 'Project back on track', when: 'An On Hold or Inactive lead is reactivated', audience: 'client', channels: ['email'], reviewed: true },
  { code: 'NPS_SURVEY', label: 'NPS survey', when: 'NPS is triggered', audience: 'client', channels: ['email'], reviewed: true, lockedReason: 'The onboarding checklist needs the NPS survey sent.' },
  { code: 'PD_OB_WELCOME', label: 'Welcome mail', when: 'PD → Onboarding checklist is completed', audience: 'client', channels: ['email'], reviewed: true, lockedReason: 'Sending it is what moves the lead to Onboarding.' },
  { code: 'OB_OBM_WELCOME', label: 'Onboarding meeting mail', when: 'Onboarding → OBM checklist is completed', audience: 'client', channels: ['email'], reviewed: true, lockedReason: 'Sending it is what moves the lead to Onboarding Meeting.' },
  // ── Emails to the team (in-app notifications always stay on) ──
  { code: 'TEAM_STATUS_CHANGE', label: 'Lead on hold / inactive / reactivated', when: 'A lead\'s status changes', audience: 'team', channels: ['email'] },
  { code: 'TEAM_STAGE_BACKWARD', label: 'Lead sent back to Effective Lead', when: 'A BL pushes a lead back from MQL', audience: 'team', channels: ['email'] },
  { code: 'TEAM_INTENT_CHANGED', label: 'Intent rating changed', when: 'A lead\'s intent rating is changed by hand', audience: 'team', channels: ['email'] },
  { code: 'TEAM_INTERNAL_CALL_NOTES', label: 'Internal call notes', when: 'Internal notes are added to a call', audience: 'team', channels: ['email'] },
  { code: 'TEAM_SLA_BREACH', label: 'SLA breach', when: 'A lead misses an SLA target (checked hourly); emailed once to its Business Lead and the Branch Heads', audience: 'team', channels: ['email'] },
  { code: 'TEAM_NO_SHOW_NO_PLAN', label: 'No-show without a new plan', when: 'A no-show is recorded with no replan', audience: 'team', channels: ['email'] },
  { code: 'STAFF_WEEKLY_DIGEST', label: 'Weekly task digest', when: 'On the weekly digest day (CRM Settings)', audience: 'team', channels: ['email'] },
  { code: 'CRE_DIGESTS', label: 'CRE pipeline reports', when: 'Daily and monthly, to CREs', audience: 'team', channels: ['email'] },
];
const EVENT_BY_CODE = new Map(AUTOMATION_EVENTS.map((e) => [e.code, e]));

export interface EventSetting {
  enabled: boolean;
  channels: Partial<Record<Channel, boolean>>;
  /** Who is copied on the client email (client events only). */
  cc: CcRole[];
  /** For emails normally reviewed first: send straight away instead. */
  sendDirect?: boolean;
}
export type AutomationSettings = Record<string, EventSetting>;

const DEFAULT_CC: Record<string, CcRole[]> = {
  CALL_LOG_SUMMARY: ['designer', 'bl', 'branchHeads'],
  CALL_SCHEDULED: ['designer', 'bl', 'branchHeads'],
};

export function defaultAutomations(): AutomationSettings {
  return Object.fromEntries(AUTOMATION_EVENTS.map((e) => [e.code, {
    enabled: true,
    channels: Object.fromEntries(e.channels.map((c) => [c, true])),
    cc: e.audience === 'client' ? [...(DEFAULT_CC[e.code] ?? [])] : [],
  }]));
}

function mergeAutomations(saved: Partial<AutomationSettings> | undefined): AutomationSettings {
  const d = defaultAutomations();
  for (const [code, s] of Object.entries(saved ?? {})) {
    if (!d[code] || !s) continue;
    const locked = !!EVENT_BY_CODE.get(code)?.lockedReason;
    d[code] = locked ? { ...d[code], cc: s.cc ?? d[code].cc } : { ...d[code], ...s, channels: { ...d[code].channels, ...s.channels } };
  }
  return d;
}

const settingSchema = z.object({
  enabled: z.boolean(),
  channels: z.record(z.enum(['email', 'sms', 'whatsapp']), z.boolean()),
  cc: z.array(z.enum(['designer', 'bl', 'cre', 'branchHeads'])),
  /** For emails normally reviewed first: send straight away instead. */
  sendDirect: z.boolean().optional(),
}).strict();

function validateAutomations(raw: unknown): AutomationSettings {
  const parsed = z.record(z.string(), settingSchema).safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(400, 'The automations could not be saved', describeIssues(parsed.error.issues, Object.fromEntries(AUTOMATION_EVENTS.map((e) => [e.code, e.label]))));
  }
  const problems: string[] = [];
  for (const [code, s] of Object.entries(parsed.data)) {
    const event = EVENT_BY_CODE.get(code);
    if (!event) { problems.push(`Unknown automation "${code}"`); continue; }
    for (const c of Object.keys(s.channels)) if (!event.channels.includes(c as Channel)) problems.push(`${event.label}: it can't be sent by ${c}`);
    if (event.audience === 'team' && s.cc.length) problems.push(`${event.label}: only client emails can copy people`);
    if (s.sendDirect && (!event.reviewed || event.lockedReason)) problems.push(`${event.label}: this email can't skip the review step`);
  }
  if (problems.length) throw new ConfigError(400, 'The automations could not be saved', problems);
  // Locked events stay on with all channels whatever is submitted.
  return mergeAutomations(parsed.data);
}

export const automationsConfig = versionedConfig<AutomationSettings>({
  key: 'automations_v1',
  action: 'AUTOMATIONS',
  noun: 'the automations',
  defaults: defaultAutomations,
  merge: mergeAutomations,
  validate: validateAutomations,
});

const DRAFT_TYPE_EVENTS: Record<string, string> = {
  MEETING_COMPLETED: 'MOM', MEETING_RESCHEDULED: 'RESCHEDULED', MEETING_NO_SHOW: 'NO_SHOW',
};
/** The automation an email draft's type belongs to (e.g. MEETING_COMPLETED → MOM, NPS_ONBOARDING → NPS_SURVEY). */
export function eventForDraftType(type: string): string {
  if (type.startsWith('NPS_')) return 'NPS_SURVEY';
  return DRAFT_TYPE_EVENTS[type] ?? type;
}

/** True when Admin → Automations says this normally-reviewed email goes out without the review step. */
export async function sendsWithoutReview(event: string): Promise<boolean> {
  const def = EVENT_BY_CODE.get(event);
  if (!def?.reviewed || def.lockedReason) return false;
  return (await automationsConfig.get())[event]?.sendDirect === true;
}

/** Whether `event` should send on `channel` (omit channel to ask if the event is on at all). */
export async function isAutomationOn(event: string, channel?: Channel): Promise<boolean> {
  const s = (await automationsConfig.get())[event];
  if (!s) return true; // events not in the list are never switched off
  if (!s.enabled) return false;
  return channel ? s.channels[channel] !== false : true;
}

/** Email addresses to copy on `event`'s client email for this lead. */
export async function automationCc(event: string, leadId: string): Promise<string[]> {
  const roles = (await automationsConfig.get())[event]?.cc ?? [];
  if (!roles.length) return [];
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { assignedDesignerId: true, assignedBLId: true, assignedCREId: true },
  });
  if (!lead) return [];
  const ids = [
    roles.includes('designer') && lead.assignedDesignerId,
    roles.includes('bl') && lead.assignedBLId,
    roles.includes('cre') && lead.assignedCREId,
  ].filter((v): v is string => !!v);
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      OR: [{ id: { in: ids } }, ...(roles.includes('branchHeads') ? [{ role: 'BRANCH_HEAD' as const }] : [])],
    },
    select: { email: true },
  });
  return Array.from(new Set(users.map((u) => u.email).filter(Boolean)));
}
