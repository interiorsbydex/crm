/**
 * Admin-editable mail template registry (Task #66).
 *
 * Every system-triggered email that previously had a hardcoded default
 * subject/body is registered here with a code, a human label, and a list of
 * `{{placeholder}}` tokens available to admins when editing it. Admin
 * overrides are stored as a single JSON blob on AssignmentConfig (the same
 * generic key-value config table used for SLA threshold overrides), keyed by
 * template code. When no override exists, the hardcoded default is used —
 * so this is purely additive and never breaks a fresh install.
 *
 * Per-send editable modals (PD→OB "Share welcome mail", OB→OBM "Share OBM
 * mail") already let a user tweak the wording for one send; this registry
 * controls what they see pre-filled by default.
 */
import { prisma } from './prisma.js';
import type { MasterMailAttachment } from './mailTemplateAttachments.js';

export interface MailTemplateDef {
  code: string;
  label: string;
  description: string;
  placeholders: string[];
  defaultSubject: string;
  defaultHtml: string;
}

export const MAIL_TEMPLATES: MailTemplateDef[] = [
  {
    code: 'PD_OB_WELCOME',
    label: 'Welcome mail (PD (Pitch Discussion) → Onboarding)',
    description: 'Sent when the PD→OB checklist is completed and the lead moves to Onboarding.',
    placeholders: ['clientName'],
    defaultSubject: 'Welcome Onboard — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Congratulations and welcome aboard! We're thrilled to begin your interior design journey with <strong>Interiors by DeX</strong>.</p>
<p>Our onboarding team will be in touch shortly with the next steps, including your onboarding meeting.</p>
<p>Thank you for choosing us — we can't wait to bring your space to life!<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'OB_OBM_WELCOME',
    label: 'OBM mail (Onboarding → Onboarding Meeting)',
    description: 'Sent when the OB→OBM checklist is completed and the lead moves to Onboarding Meeting.',
    placeholders: ['clientName', 'timeline'],
    defaultSubject: 'Your Onboarding is Complete — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Great news — your onboarding with <strong>Interiors by DeX</strong> is now complete!</p>
<p>Your dedicated design team will reach out shortly to kick off the design process. Here's your project timeline:</p>
{{timeline}}
<p>Thank you for your trust — we're excited to get started!<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'MEETING_CONFIRMATION',
    label: 'Meeting confirmation',
    description: 'Sent automatically whenever a meeting is scheduled.',
    placeholders: ['clientName', 'type', 'mode', 'scheduledAt', 'designerName', 'attachmentsHtml'],
    defaultSubject: 'Meeting Confirmed — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Your <strong>{{type}} meeting</strong> has been scheduled for <strong>{{scheduledAt}}</strong>.</p>
<p>Mode: {{mode}}<br/>Designer: {{designerName}}</p>
{{attachmentsHtml}}
<p>Looking forward to meeting you!<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'MOM',
    label: 'Minutes of Meeting (MOM)',
    description: 'Sent automatically when a meeting is marked Completed.',
    placeholders: ['clientName', 'meetingType', 'scheduledAt', 'mom', 'attachmentsHtml'],
    defaultSubject: 'Minutes of Meeting — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Thank you for your time during our <strong>{{meetingType}}</strong> on {{scheduledAt}}.</p>
<p><strong>Meeting Summary:</strong></p>
<p>{{mom}}</p>
{{attachmentsHtml}}
<p>We'll be in touch with next steps.<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'CALL_LOG_SUMMARY',
    label: 'Call summary (sent when a call is logged as answered)',
    description: 'Sent automatically to the client, CC\u2019d to the designer/BL/management, once a call outcome is logged as Answered. Uses ONLY External Notes — Internal Notes are staff-only and never appear here.',
    placeholders: ['clientName', 'externalNotes', 'attachmentsHtml', 'followUpDate'],
    defaultSubject: 'Call Summary — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Thank you for speaking with us today. Here's a quick summary of what we discussed:</p>
<p>{{externalNotes}}</p>
{{attachmentsHtml}}
<p>Next follow-up: <strong>{{followUpDate}}</strong></p>
<p>Team Interiors by DeX</p>`,
  },
  {
    code: 'NEXT_PLAN_OF_ACTION',
    label: 'Next plan of action item',
    description: 'Sent to the client when a call/meeting/task added to the "next plan of action" is flagged for external notification.',
    placeholders: ['clientName', 'kind', 'details'],
    defaultSubject: 'Next Steps — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>As discussed, here are the next steps ({{kind}}):</p>
<p>{{details}}</p>
<p>Team Interiors by DeX</p>`,
  },
  {
    code: 'NO_SHOW',
    label: 'No-show follow-up',
    description: 'Sent automatically to the client when they no-show a scheduled meeting.',
    placeholders: ['clientName'],
    defaultSubject: 'We Missed You — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>We noticed you weren't able to make it to today's meeting. No worries!</p>
<p>Please reply to this email with your availability so we can reschedule at a time that works for you.</p>
<p>Looking forward to connecting!<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'RESCHEDULED',
    label: 'Meeting rescheduled',
    description: 'Sent automatically to the client when a meeting is rescheduled.',
    placeholders: ['clientName', 'reason'],
    defaultSubject: 'Meeting Rescheduled — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Your meeting has been rescheduled. Reason: {{reason}}</p>
<p>Our team will reach out shortly to confirm the new time.<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'ON_HOLD',
    label: 'Lead placed On Hold',
    description: 'Sent automatically to the client when their lead is placed On Hold.',
    placeholders: ['clientName', 'revivalDate', 'reason', 'externalNotesHtml'],
    defaultSubject: 'Your Project is On Hold — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>We wanted to let you know that your interior design project with <strong>Interiors by DeX</strong> has been placed on hold.</p>
<p><strong>Revival Date:</strong> {{revivalDate}}<br/>
<strong>Reason:</strong> {{reason}}</p>
{{externalNotesHtml}}
<p>We will reach out to you on or before the revival date to resume the project. In the meantime, feel free to contact us with any questions.</p>
<p>Thank you for your patience!<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'INACTIVATION_FEEDBACK',
    label: 'Inactivation feedback request',
    description: 'Sent automatically to the client when their lead is marked Inactive.',
    placeholders: ['clientName', 'feedbackUrl', 'reasonHtml', 'externalNotesHtml'],
    defaultSubject: "We'd love your feedback — Interiors by DeX",
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Thank you for your interest in Interiors by DeX.</p>
{{reasonHtml}}
{{externalNotesHtml}}
<p>We'd really appreciate a minute of your time to share your thoughts — it helps us improve:</p>
<p><a href="{{feedbackUrl}}" style="background:#d95f32;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Share Feedback</a></p>
<p>Thank you!<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'REACTIVATION',
    label: 'Lead reactivated',
    description: 'Sent automatically to the client when their On Hold/Inactive lead is reactivated.',
    placeholders: ['clientName', 'notesHtml'],
    defaultSubject: 'Your Project is Back On Track — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Good news — your interior design project with <strong>Interiors by DeX</strong> is now active again and our team will be in touch shortly.</p>
{{notesHtml}}
<p>Thank you for your patience!<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'NPS_SURVEY',
    label: 'NPS survey request',
    description: 'Sent automatically to the client when a stage milestone triggers an NPS survey.',
    placeholders: ['clientName', 'stageName', 'ratingUrl', 'scoreLinksHtml'],
    defaultSubject: 'Quick feedback on your {{stageName}} experience — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Your <strong>{{stageName}}</strong> milestone with Interiors by DeX is complete — congratulations! 🎉</p>
<p>We'd love to know: on a scale of <strong>0–10</strong>, how likely are you to recommend us to a friend or family?</p>
<p style="text-align:center;margin:24px 0;">{{scoreLinksHtml}}</p>
<p style="text-align:center;font-size:12px;color:#9ca3af;">0 = Not at all likely &nbsp;&nbsp;&nbsp; 10 = Extremely likely</p>
<p>Or tap here to open the survey: <a href="{{ratingUrl}}" style="color:#d95f32">{{ratingUrl}}</a></p>
<p>Thank you for trusting us with your space!<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'CALL_SCHEDULED',
    label: 'Scheduled call notification (External calls)',
    description: 'Sent to the client when a call is scheduled with Internal/External set to External.',
    placeholders: ['clientName', 'stageType', 'scheduledDate', 'scheduledTime', 'agendaHtml'],
    defaultSubject: 'Call Scheduled — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>We have scheduled a call with you for your <strong>{{stageType}}</strong> discussion.</p>
<p><strong>Date:</strong> {{scheduledDate}}<br/>
<strong>Time:</strong> {{scheduledTime}}</p>
{{agendaHtml}}
<p>Our team will call you at the scheduled time. If you need to reschedule, please reply to this email.</p>
<p>Looking forward to speaking with you!<br/><em>Team Interiors by DeX</em></p>`,
  },
  // Fix B — external follow-up task notification (was hardcoded in tasks.ts).
  {
    code: 'EXTERNAL_TASK',
    label: 'External follow-up task notification',
    description: 'Sent to the client when a follow-up task is scheduled as External (client-facing).',
    placeholders: ['clientName', 'dueDate', 'dueTime', 'agendaHtml'],
    defaultSubject: 'Upcoming follow-up — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>We have a follow-up scheduled with you on <strong>{{dueDate}}{{dueTime}}</strong>.</p>
{{agendaHtml}}
<p>Team Interiors by DeX</p>`,
  },
  {
    code: 'CALL_RESCHEDULED',
    label: 'External call rescheduled',
    description: 'Sent to the client when an external scheduled call is moved to a new date and time.',
    placeholders: ['clientName', 'scheduledDate', 'scheduledTime', 'reason', 'agendaHtml'],
    defaultSubject: 'Call Rescheduled — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Your call with Interiors by DeX has been rescheduled to:</p>
<p><strong>Date:</strong> {{scheduledDate}}<br/>
<strong>Time:</strong> {{scheduledTime}}</p>
<p><strong>Reason:</strong> {{reason}}</p>
{{agendaHtml}}
<p>We look forward to speaking with you.<br/><em>Team Interiors by DeX</em></p>`,
  },
  // Fix C — 1-hour-before auto-send reminders (client-facing).
  {
    code: 'MEETING_REMINDER',
    label: '1-hour meeting reminder (auto-sent to client)',
    description: 'Auto-sent directly to the client ~1 hour before a scheduled meeting.',
    placeholders: ['clientName', 'meetingType', 'scheduledAt'],
    defaultSubject: 'Reminder: your meeting is in 1 hour — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>This is a friendly reminder that your <strong>{{meetingType}}</strong> meeting with Interiors by DeX is starting in approximately <strong>1 hour</strong>.</p>
<p><strong>Scheduled at:</strong> {{scheduledAt}}</p>
<p>We look forward to speaking with you!<br/><em>Team Interiors by DeX</em></p>`,
  },
  {
    code: 'TASK_REMINDER',
    label: '1-hour follow-up task reminder (auto-sent to client)',
    description: 'Auto-sent directly to the client ~1 hour before an external follow-up task is due.',
    placeholders: ['clientName', 'dueDate', 'dueTime', 'agendaHtml'],
    defaultSubject: 'Reminder: follow-up in 1 hour — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>This is a reminder that we have a follow-up with you today at <strong>{{dueTime}}</strong> ({{dueDate}}).</p>
{{agendaHtml}}
<p>Team Interiors by DeX</p>`,
  },
  // Fix C — Tuesday weekly digest draft (review-then-send).
  {
    code: 'WEEKLY_DIGEST',
    label: 'Weekly digest for client (Tuesday)',
    description: 'Sent every Tuesday as a draft for designer/BL review — summarises the client\'s upcoming meetings and tasks for the week.',
    placeholders: ['clientName', 'itemsHtml'],
    defaultSubject: "This week's schedule — Interiors by DeX",
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Here is a summary of your upcoming appointments with Interiors by DeX this week:</p>
{{itemsHtml}}
<p>If you need to reschedule anything, please reply to this email and we'll sort it out for you.</p>
<p>Looking forward to it!<br/><em>Team Interiors by DeX</em></p>`,
  },
  // Fix D — Proposal Ready notification (no attachment).
  {
    code: 'PROPOSAL_READY',
    label: 'Proposal Ready notification',
    description: 'Sent to the client when their lead moves to Proposal Ready stage. No attachment — plain text only.',
    placeholders: ['clientName', 'leadRef'],
    defaultSubject: 'Your proposal is ready — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Great news — your interior design proposal (ref: <strong>{{leadRef}}</strong>) is now ready for review.</p>
<p>Our team will be in touch shortly to walk you through the details and answer any questions.</p>
<p>Thank you for your patience — we're excited to share what we've put together for your space!<br/><em>Team Interiors by DeX</em></p>`,
  },
];

const MAIL_TEMPLATE_CONFIG_KEY = 'mail_template_overrides';

type Overrides = Record<string, { subject?: string; html?: string; attachments?: MasterMailAttachment[] }>;

export async function getMailTemplateOverrides(): Promise<Overrides> {
  const row = await prisma.assignmentConfig.findUnique({ where: { key: MAIL_TEMPLATE_CONFIG_KEY } });
  return (row?.value as Overrides) ?? {};
}

/** Full list with each template's effective (override-aware) default subject/html, unfilled placeholders intact. */
export async function getEffectiveMailTemplates(): Promise<(MailTemplateDef & { subject: string; html: string; attachments: MasterMailAttachment[] })[]> {
  const overrides = await getMailTemplateOverrides();
  return MAIL_TEMPLATES.map((t) => ({
    ...t,
    subject: overrides[t.code]?.subject?.trim() || t.defaultSubject,
    html: overrides[t.code]?.html?.trim() || t.defaultHtml,
    attachments: overrides[t.code]?.attachments ?? [],
  }));
}

export async function setMailTemplateOverride(code: string, subject: string, html: string, attachments?: MasterMailAttachment[]): Promise<void> {
  const def = MAIL_TEMPLATES.find((t) => t.code === code);
  if (!def) throw new Error(`Unknown mail template: ${code}`);
  const overrides = await getMailTemplateOverrides();
  overrides[code] = { ...overrides[code], subject: subject.trim(), html: html.trim(), ...(attachments !== undefined ? { attachments } : {}) };
  await prisma.assignmentConfig.upsert({
    where: { key: MAIL_TEMPLATE_CONFIG_KEY },
    create: { key: MAIL_TEMPLATE_CONFIG_KEY, value: overrides as any },
    update: { value: overrides as any },
  });
}

export async function resetMailTemplateOverride(code: string): Promise<void> {
  const overrides = await getMailTemplateOverrides();
  const attachments = overrides[code]?.attachments;
  if (attachments?.length) overrides[code] = { attachments };
  else delete overrides[code];
  await prisma.assignmentConfig.upsert({
    where: { key: MAIL_TEMPLATE_CONFIG_KEY },
    create: { key: MAIL_TEMPLATE_CONFIG_KEY, value: overrides as any },
    update: { value: overrides as any },
  });
}

export async function getWelcomeMailAttachments(): Promise<MasterMailAttachment[]> {
  return (await getMailTemplateOverrides()).OB_OBM_WELCOME?.attachments ?? [];
}

function fillPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

/** Effective (override-aware) subject+html for one template, with `{{placeholders}}` filled from `vars`. */
export async function renderMailTemplate(code: string, vars: Record<string, string>): Promise<{ subject: string; html: string }> {
  const def = MAIL_TEMPLATES.find((t) => t.code === code);
  if (!def) throw new Error(`Unknown mail template: ${code}`);
  const overrides = await getMailTemplateOverrides();
  const subject = overrides[code]?.subject?.trim() || def.defaultSubject;
  const html = overrides[code]?.html?.trim() || def.defaultHtml;
  return { subject: fillPlaceholders(subject, vars), html: fillPlaceholders(html, vars) };
}
