/**
 * "Send straight away" for client emails (Admin → Automations).
 *
 * Every flow that prepares a client email returns it to the screen for review
 * in a `pendingMail` field (or `npsPendingMail`, `nextPlanPendingMail`, …).
 * This middleware looks at those fields as the response leaves: when the
 * admin has set that email to skip review, it sends the draft right away —
 * through the same sendDraft() the review screen's Send button uses, so
 * copies, attachments and follow-up actions are identical — and replaces the
 * field with an `autoSent` entry. If sending fails, the draft is left in the
 * response for the person to review and send as before.
 */
import type { Request, Response, NextFunction } from 'express';
import { eventForDraftType, sendsWithoutReview } from './automations.js';
import { sendDraft } from './emailService.js';

const isDraftField = (key: string) => key === 'pendingMail' || key.endsWith('PendingMail');

export function autoSendDrafts(req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = ((body: any) => {
    const keys = body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body).filter((k) => isDraftField(k) && body[k]?.draftKey && body[k]?.to && body[k]?.type)
      : [];
    if (!keys.length || !req.user || res.statusCode >= 400) return json(body);
    (async () => {
      const sent: { type: string; to: string }[] = [];
      for (const key of keys) {
        const mail = body[key];
        if (!(await sendsWithoutReview(eventForDraftType(mail.type)))) continue;
        try {
          await sendDraft(mail.draftKey, mail.to, req.user!.id);
          sent.push({ type: mail.type, to: mail.to });
          body[key] = undefined;
        } catch (err: any) {
          console.warn(`[auto-send] ${mail.type} could not be sent, left for review:`, err?.message);
        }
      }
      if (sent.length) body.autoSent = [...(body.autoSent ?? []), ...sent];
      json(body);
    })().catch(() => json(body));
    return res;
  }) as Response['json'];
  next();
}
