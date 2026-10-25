/**
 * SMS Service — Twilio SMS (same account as WhatsApp)
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_NUMBER
 *
 * All phone numbers are formatted to E.164 (+91XXXXXXXXXX) before sending.
 */

import { prisma } from '../lib/prisma.js';

function toE164India(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith('+')) return phone.replace(/\s/g, '');
  return `+${digits}`;
}

export async function sendSms(
  toPhone: string,
  message: string,
  leadId?: string,
): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_SMS_NUMBER;

  const to = toE164India(toPhone);

  if (!sid || !token || !from) {
    console.log(`[sms:dev] Would send to ${to}: ${message.slice(0, 60)}…`);
    await logSms(leadId, to, message, undefined, 'dev_skip');
    return;
  }

  let twilioSid: string | undefined;
  let status = 'queued';

  try {
    const body = new URLSearchParams({ To: to, From: from, Body: message });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        },
        body: body.toString(),
      },
    );

    const json = (await res.json()) as any;
    if (!res.ok) {
      console.error('[sms] Twilio error:', json.message);
      status = 'failed';
    } else {
      twilioSid = json.sid;
      status = json.status ?? 'queued';
    }
  } catch (e: any) {
    console.error('[sms] Send error:', e.message);
    status = 'failed';
  }

  await logSms(leadId, to, message, twilioSid, status);
}

async function logSms(
  leadId: string | undefined,
  toPhone: string,
  body: string,
  twilioSid?: string,
  status?: string,
) {
  await prisma.smsLog
    .create({ data: { leadId: leadId ?? null, toPhone, body, twilioSid, status: status ?? 'queued' } })
    .catch((e) => console.warn('[sms] Log write failed:', e.message));
}
