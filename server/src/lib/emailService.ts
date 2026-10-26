import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { prisma } from './prisma.js';
import { logActivity } from './activityLog.js';
import { sendEmail, type EmailAttachment } from './email.js';
import { automationCc, eventForDraftType } from './automations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '../../templates/email');

// Real delivery (Resend / SMTP / dev-guard) is centralized in ./email.ts —
// this module used to keep its own separate Nodemailer transporter, which
// silently bypassed Resend entirely. It now delegates to sendEmail().

// ── Fill HTML template with variables ────────────────────────────────────────
function fillTemplate(templateName: string, vars: Record<string, string>): string {
  const filePath = resolve(TEMPLATES_DIR, `${templateName}.html`);
  let html = readFileSync(filePath, 'utf-8');
  for (const [key, val] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, val);
  }
  return html;
}

// ── Email type → template mapping ─────────────────────────────────────────────
const EMAIL_TEMPLATES: Record<string, { template: string; subject: string }> = {
  MEETING_CONFIRMATION: { template: 'meeting_confirmation', subject: 'Meeting Confirmed — Interiors by DeX' },
  MOM: { template: 'mom', subject: 'Meeting Summary — Interiors by DeX' },
  ONBOARDING: { template: 'onboarding', subject: 'Welcome to Interiors by DeX!' },
  NO_SHOW: { template: 'no_show', subject: "We Missed You — Let's Reconnect" },
  RESCHEDULED: { template: 'rescheduled', subject: 'Meeting Rescheduled — Interiors by DeX' },
  ON_HOLD: { template: 'on_hold', subject: 'Project Update — Interiors by DeX' },
  INACTIVATION_FEEDBACK: { template: 'inactivation_feedback', subject: 'A quick note from Interiors by DeX' },
  SLA_BREACH: { template: 'mom', subject: 'SLA Alert — Interiors by DeX' }, // reuses mom template
};

// ── Main send function ────────────────────────────────────────────────────────
export async function sendEmailByType(
  type: string,
  leadId: string,
  vars: Record<string, string>,
  to?: string,
): Promise<void> {
  const config = EMAIL_TEMPLATES[type];
  if (!config) throw new Error(`Unknown email type: ${type}`);

  const html = fillTemplate(config.template, vars);

  if (to) {
    await sendEmail({ to, subject: config.subject, html });
  }

  // Log the send
  if (to) {
    await prisma.emailLog.create({
      data: { leadId, type, sentTo: to, subject: config.subject },
    }).catch((e) => console.warn('[emailService] Log write failed:', e.message));
  }
}

// ── Preview: fills template without sending ───────────────────────────────────
export function previewEmail(type: string, vars: Record<string, string>): string {
  const config = EMAIL_TEMPLATES[type];
  if (!config) throw new Error(`Unknown email type: ${type}`);
  return fillTemplate(config.template, vars);
}

// ── Draft storage ─────────────────────────────────────────────────────────────
// Drafts live in the EmailDraft table, not server memory, so one prepared on
// one server instance can be sent from another, and survives a restart.
// onSentAction lets a route register a stage/checklist side-effect that must
// only run once the draft is *actually sent* (never at draft-creation time) —
// used by PD→OB welcome mail and OB→OBM mail, which previously advanced the
// lead's stage synchronously with the send instead of on real delivery.
interface DraftMeta { leadId: string; type: string; onSentAction?: string }
export interface Draft { subject: string; html: string; meta?: DraftMeta; attachments?: EmailAttachment[] }

// Registry of post-send side-effect handlers, keyed by `onSentAction`.
// Populated by the routes that need one (pdObChecklist.ts, obObmChecklist.ts)
// so this generic email infra never has to import checklist-specific logic.
// userId is whoever clicked "send" on the draft, for activity-log attribution
// (never a placeholder system user — see SYSTEM_USER_ID FK gotcha).
type OnSentHandler = (leadId: string, userId: string) => Promise<void>;
const onSentHandlers = new Map<string, OnSentHandler>();

export function registerOnSentHandler(action: string, handler: OnSentHandler) {
  onSentHandlers.set(action, handler);
}

export async function saveDraft(key: string, subject: string, html: string, meta?: DraftMeta, attachments?: EmailAttachment[]): Promise<void> {
  // Preserve meta/attachments set at creation time (e.g. by meetings.ts) even
  // if the caller re-saving edited content (routes/email.ts PATCH /draft)
  // doesn't pass them again.
  const existing = await getDraft(key);
  const sameIdentity = meta && existing?.meta
    && meta.leadId === existing.meta.leadId && meta.type === existing.meta.type;
  const preservedMeta = sameIdentity ? { ...existing!.meta, ...meta } : meta ?? existing?.meta;
  const data = {
    subject,
    html,
    meta: (preservedMeta ?? undefined) as any,
    attachments: (attachments ?? existing?.attachments ?? undefined) as any,
  };
  await prisma.emailDraft.upsert({ where: { key }, create: { key, ...data }, update: data });
}

export async function getDraft(key: string): Promise<Draft | null> {
  const row = await prisma.emailDraft.findUnique({ where: { key } });
  if (!row) return null;
  return {
    subject: row.subject,
    html: row.html,
    meta: (row.meta as unknown as DraftMeta | null) ?? undefined,
    attachments: (row.attachments as unknown as EmailAttachment[] | null) ?? undefined,
  };
}

export async function sendDraft(key: string, to: string, sentByUserId?: string): Promise<void> {
  const draft = await getDraft(key);
  if (!draft) throw new Error('Draft not found');

  // Who is copied follows Admin → Automations for this kind of email.
  const cc = draft.meta ? (await automationCc(eventForDraftType(draft.meta.type), draft.meta.leadId)).filter((e) => e !== to) : [];
  await sendEmail({ to, cc, subject: draft.subject, html: draft.html, attachments: draft.attachments });
  await prisma.emailDraft.deleteMany({ where: { key } });

  if (draft.meta?.onSentAction) {
    const handler = onSentHandlers.get(draft.meta.onSentAction);
    if (handler && sentByUserId) await handler(draft.meta.leadId, sentByUserId);
    else if (handler) console.warn(`[emailService] onSentAction "${draft.meta.onSentAction}" skipped — no sending user id provided`);
    else console.warn(`[emailService] No onSentAction handler registered for "${draft.meta.onSentAction}"`);
  }

  if (draft.meta) {
    await prisma.emailLog.create({
      data: { leadId: draft.meta.leadId, type: draft.meta.type, sentTo: to, subject: draft.subject },
    }).catch((e) => console.warn('[emailService] Log write failed:', e.message));
    // Lead history: an email went to the client. (Mails that move a lead to its next stage already leave their own entry.)
    if (sentByUserId && !draft.meta.onSentAction) {
      await logActivity(sentByUserId, 'CLIENT_EMAIL_SENT', draft.meta.leadId, { type: draft.meta.type, subject: draft.subject, to })
        .catch((e) => console.warn('[emailService] Activity write failed:', e.message));
    }
  }
}
