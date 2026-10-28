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
    placeholders: ['clientName', 'paymentValue', 'projectValue', 'furnitureValue', 'designerName', 'leadRef', 'obMeetingAt', 'obMeetingLocation', 'notesHtml'],
    defaultSubject: 'Welcome Onboard — Interiors by DeX',
    defaultHtml: `<p>Dear {{clientName}},</p>
<p>Congratulations and welcome aboard! We're thrilled to begin your interior design journey with <strong>Interiors by DeX</strong>.</p>
<p>We have received your payment of <strong>{{paymentValue}}</strong> towards your project value of <strong>{{projectValue}}</strong>.</p>
{{notesHtml}}
<p>Our team will be in touch with you for your onboarding meeting on <strong>{{obMeetingAt}}</strong> at <strong>{{obMeetingLocation}}</strong>.</p>
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
<div style="margin:20px 0;padding:14px 16px;background:#faf7f4;border-radius:8px;font-size:13px;line-height:1.5;color:#374151;">
<p style="margin:0 0 10px;"><strong>What the scores mean</strong></p>
<p style="margin:0 0 10px;"><strong>10 – Excellent</strong><br/>All requirements were clearly understood, communication was seamless, and the proposal aligned perfectly with my expectations.</p>
<p style="margin:0 0 10px;"><strong>9 – Very Good</strong><br/>My requirements were well understood, and the communication and proposal were clear, with only minor gaps.</p>
<p style="margin:0 0 10px;"><strong>8 – Good</strong><br/>The overall experience was satisfactory, but there is some room for improvement in requirement understanding, communication, or coordination.</p>
<p style="margin:0;"><strong>Below 8 – Needs Improvement</strong><br/>The experience did not fully meet my expectations, and improvements are needed in understanding my requirements, communication, or coordination.</p>
</div>
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

/**
 * Plain-English help for every placeholder, shown beside each mail template in
 * Settings so nobody has to read the code. `example` is what a client would see.
 * A placeholder missing here still works; it just shows no help.
 */
export interface PlaceholderHelp { name: string; meaning: string; example: string }
const PLACEHOLDER_HELP: Record<string, { meaning: string; example: string }> = {
  clientName: { meaning: "The client's name, as saved on the lead.", example: 'Priya Sharma' },
  paymentValue: { meaning: 'The payment amount received, from the "Payment value" box on the PD→OB checklist. Shown in rupees.', example: '₹1,50,000' },
  projectValue: { meaning: 'The total project value, from the "Project value" box on the PD→OB checklist. Shown in rupees.', example: '₹18,00,000' },
  furnitureValue: { meaning: 'The furniture value, from the "Furniture value" box on the PD→OB checklist. Shown in rupees.', example: '₹2,50,000' },
  obMeetingAt: { meaning: 'The date and time of the onboarding meeting, from the "OB meeting date/time" box on the PD→OB checklist.', example: '14 Nov 2026, 11:30 am' },
  obMeetingLocation: { meaning: 'Where the onboarding meeting takes place, from the "OB meeting location" box on the PD→OB checklist.', example: "Client's Site" },
  notesHtml: { meaning: 'The notes typed when the lead was reactivated, shown as their own paragraph. If there are none, nothing appears.', example: 'Note: We are ready to restart.' },
  'PD_OB_WELCOME.notesHtml': { meaning: 'The notes typed in the "Notes" box on the PD→OB checklist, shown as their own paragraph. If there are no notes, nothing appears (not even a gap).', example: 'Notes: Please keep the balcony measurements ready.' },
  stageName: { meaning: 'The name of the milestone the survey is about.', example: 'Design Freeze' },
  ratingUrl: { meaning: 'The web address of the survey page. Use it inside a link.', example: 'https://…' },
  scoreLinksHtml: { meaning: 'The row of clickable 0 to 10 score buttons.', example: '0 1 2 3 … 10 as buttons' },
  stageType: { meaning: 'What the call is about.', example: 'Design Discussion' },
  scheduledDate: { meaning: 'The date of the call.', example: '14 Nov 2026' },
  scheduledTime: { meaning: 'The time of the call.', example: '11:30 am' },
  dueDate: { meaning: 'The date of the follow-up.', example: '14 Nov 2026' },
  dueTime: { meaning: 'The time of the follow-up.', example: '11:30 am' },
  agendaHtml: { meaning: 'The agenda or notes for the call or follow-up, shown as their own paragraph. Empty when there are none.', example: 'Agenda: Review the quotation.' },
  itemsHtml: { meaning: "The list of the client's meetings and tasks for the week.", example: 'A list of dates, times and meeting names' },
  timeline: { meaning: 'A table of the project milestones and their dates.', example: 'A small table: Milestone / Date' },
  type: { meaning: 'The kind of meeting.', example: 'Site Visit' },
  meetingType: { meaning: 'The kind of meeting.', example: 'Site Visit' },
  mode: { meaning: 'How the meeting happens (visit, virtual, and so on).', example: 'Virtual' },
  scheduledAt: { meaning: 'The date and time of the meeting.', example: '14 Nov 2026, 11:30 am' },
  designerName: { meaning: "The name of the lead's designer.", example: 'Rahul Menon' },
  attachmentsHtml: { meaning: 'A short list of the files attached to the mail. Empty when nothing is attached.', example: 'Attached: Floor plan.pdf' },
  mom: { meaning: 'The minutes of the meeting, as typed when the meeting was marked Completed.', example: 'We agreed on the layout and the next steps.' },
  externalNotes: { meaning: 'The notes meant for the client, typed when the call was logged. Internal notes are never included.', example: 'Discussed the kitchen layout.' },
  followUpDate: { meaning: 'The date and time of the next follow-up.', example: '16 Nov 2026, 4:00 pm' },
  kind: { meaning: 'What kind of next step it is (call, meeting or task).', example: 'call' },
  details: { meaning: 'The details of the next step, as typed by the team.', example: 'Share the revised quotation.' },
  reason: { meaning: 'The reason entered by the team.', example: 'Client travelling' },
  revivalDate: { meaning: 'The date the project is expected to restart.', example: '10 Jan 2027' },
  externalNotesHtml: { meaning: 'The notes meant for the client, shown as their own paragraph. Empty when there are none.', example: 'Note: We will call you after the festival.' },
  feedbackUrl: { meaning: 'The web address of the feedback form. Use it inside a link.', example: 'https://…' },
  reasonHtml: { meaning: 'The reason for closing the lead, shown as its own paragraph. Empty when none was given.', example: 'Reason: Budget' },
  leadRef: { meaning: "The lead's reference number.", example: 'IBD-1042' },
};
export function placeholderHelp(names: string[], code?: string): PlaceholderHelp[] {
  return names.map((name) => {
    const h = PLACEHOLDER_HELP[`${code}.${name}`] ?? PLACEHOLDER_HELP[name];
    return { name, meaning: h?.meaning ?? 'Filled in automatically when the mail is sent.', example: h?.example ?? '' };
  });
}

const MAIL_TEMPLATE_CONFIG_KEY = 'mail_template_overrides';

type Overrides = Record<string, { subject?: string; html?: string; attachments?: MasterMailAttachment[] }>;

export async function getMailTemplateOverrides(): Promise<Overrides> {
  const row = await prisma.assignmentConfig.findUnique({ where: { key: MAIL_TEMPLATE_CONFIG_KEY } });
  return (row?.value as Overrides) ?? {};
}

/** Full list with each template's effective (override-aware) default subject/html, unfilled placeholders intact. */
export async function getEffectiveMailTemplates(): Promise<(MailTemplateDef & { subject: string; html: string; attachments: MasterMailAttachment[]; placeholderHelp: PlaceholderHelp[] })[]> {
  const overrides = await getMailTemplateOverrides();
  return MAIL_TEMPLATES.map((t) => ({
    ...t,
    subject: overrides[t.code]?.subject?.trim() || t.defaultSubject,
    html: overrides[t.code]?.html?.trim() || t.defaultHtml,
    attachments: overrides[t.code]?.attachments ?? [],
    placeholderHelp: placeholderHelp(t.placeholders, t.code),
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

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/,(?=[A-Za-z])/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NpsSurveyWording { question: string | null; scoreMeanings: { title: string; text: string }[] }

/**
 * The question and "What the scores mean" lines from an NPS email body, so the
 * survey page asks exactly what the email asked (Admin → Mail Templates).
 * Question: the paragraph that mentions the 0–10 scale. Meanings: the
 * "<strong>title</strong><br/>text" paragraphs after "What the scores mean".
 */
export function extractNpsSurveyWording(html: string): NpsSurveyWording {
  const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1].trim());
  const questionHtml = paragraphs.find((p) => /0\s*(?:–|—|-|&ndash;|&mdash;|to)\s*10/i.test(htmlToText(p)) && !/^0\s*=/.test(htmlToText(p)));
  const scoreMeanings: { title: string; text: string }[] = [];
  const start = paragraphs.findIndex((p) => /^what the scores mean$/i.test(htmlToText(p)));
  if (start >= 0) {
    for (const p of paragraphs.slice(start + 1)) {
      const m = p.match(/^<strong>([\s\S]*?)<\/strong>\s*<br\s*\/?>([\s\S]*)$/i);
      if (!m) break;
      scoreMeanings.push({ title: htmlToText(m[1]), text: htmlToText(m[2]) });
    }
  }
  return { question: questionHtml ? htmlToText(questionHtml) || null : null, scoreMeanings };
}

export async function getNpsSurveyWording(): Promise<NpsSurveyWording> {
  const overrides = await getMailTemplateOverrides();
  const def = MAIL_TEMPLATES.find((t) => t.code === 'NPS_SURVEY')!;
  return extractNpsSurveyWording(overrides.NPS_SURVEY?.html?.trim() || def.defaultHtml);
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
