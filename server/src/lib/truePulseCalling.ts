/**
 * Calling through True Pulse (agreed with the agency, 24 Nov 2026):
 * - each designer has their own True Pulse tracking number; pressing Call in the
 *   CRM asks True Pulse to ring the designer's phone first, then the client;
 * - after every call (from the CRM or into a tracking number) True Pulse sends
 *   the result to POST /api/calls/webhook/truepulse, which we store and, when the
 *   number belongs to a lead, log on that lead.
 *
 * Secrets (Replit → Secrets): TRUEPULSE_OUTBOUND_KEY (Outbound Call key, tp_out_…)
 * and TRUEPULSE_CALL_TOKEN (the token True Pulse sends with call results).
 */
import crypto from 'crypto';
import { prisma } from './prisma.js';
import { logActivity } from './activityLog.js';
import { createNotification } from './notifications.js';
import { phoneKey } from './duplicateLeads.js';
import { ConfigError, versionedConfig } from './versionedConfig.js';

const API_BASE = 'https://app.truepulse.co.in/api/client/v1/calls/outbound';
const RNR_OUTCOMES = ['RNR_1', 'RNR_2', 'RNR_3', 'RNR_4', 'RNR_5', 'RNR_6_PLUS'] as const;
/** A typed-in call and a True Pulse result this close together are the same call. */
const SAME_CALL_WINDOW_MS = 3 * 60 * 60 * 1000;

// ── Who calls from which True Pulse number (Admin → True Pulse Calling) ──────

export type TruePulseNumber = { id: number; phone: string; label?: string };
export type TruePulseNumbers = { byUser: Record<string, TruePulseNumber> };

export const truePulseNumbersConfig = versionedConfig<TruePulseNumbers>({
  key: 'true_pulse_numbers_v1',
  action: 'TRUE_PULSE_NUMBERS',
  noun: 'the True Pulse numbers',
  defaults: () => ({ byUser: {} }),
  merge: (saved) => ({ byUser: { ...(saved?.byUser ?? {}) } }),
  validate: async (raw) => {
    const byUser = (raw as TruePulseNumbers | undefined)?.byUser;
    if (!byUser || typeof byUser !== 'object') throw new ConfigError(400, 'The True Pulse numbers could not be saved', ['Nothing to save']);
    const users = await prisma.user.findMany({ where: { id: { in: Object.keys(byUser) } }, select: { id: true, name: true } });
    const names = new Map(users.map((u) => [u.id, u.name]));
    const problems: string[] = [];
    const used = new Map<number, string>();
    const clean: Record<string, TruePulseNumber> = {};
    for (const [userId, n] of Object.entries(byUser)) {
      if (!n) continue;
      const name = names.get(userId);
      if (!name) { problems.push('One of the people no longer exists — reload the page'); continue; }
      if (!Number.isInteger(n.id) || n.id <= 0 || typeof n.phone !== 'string' || !n.phone.trim()) { problems.push(`${name}: pick a number from the list`); continue; }
      if (used.has(n.id)) problems.push(`${name} and ${used.get(n.id)} have the same True Pulse number — each person needs their own`);
      used.set(n.id, name);
      clean[userId] = { id: n.id, phone: n.phone.trim(), ...(n.label && { label: String(n.label).slice(0, 120) }) };
    }
    if (problems.length) throw new ConfigError(400, 'The True Pulse numbers could not be saved', problems);
    return { byUser: clean };
  },
});

export async function truePulseNumberFor(userId: string): Promise<TruePulseNumber | null> {
  return (await truePulseNumbersConfig.get().catch(() => ({ byUser: {} } as TruePulseNumbers))).byUser[userId] ?? null;
}

// ── Talking to True Pulse ─────────────────────────────────────────────────────

export class TruePulseError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function outboundKey(): string {
  const key = process.env.TRUEPULSE_OUTBOUND_KEY ?? '';
  if (!key) throw new TruePulseError(503, 'Calling through True Pulse is not set up yet (the True Pulse key is missing).');
  return key;
}

/** Phone number in the +91XXXXXXXXXX form True Pulse expects (Indian numbers without a code get +91). */
export function toE164(phone: string | null | undefined): string | null {
  const raw = (phone ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 8) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  return null;
}

async function callApi(path: string, init: RequestInit = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'X-API-Key': outboundKey(), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e: any) {
    if (e instanceof TruePulseError) throw e;
    throw new TruePulseError(502, 'Could not reach True Pulse. Please try again in a minute.');
  }
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.status === 'ERROR') {
    const reason = res.status === 401 || res.status === 403 ? 'True Pulse refused the key — check TRUEPULSE_OUTBOUND_KEY'
      : res.status === 404 ? 'True Pulse does not recognise this caller\'s number (it may not be enabled for outbound calls)'
      : body?.message || `True Pulse answered with an error (${res.status})`;
    throw new TruePulseError(res.status === 401 || res.status === 403 || res.status === 404 ? 400 : 502, reason);
  }
  return body;
}

/** Tracking numbers that can place outbound calls (for the Admin screen). */
export async function listOutboundNumbers(): Promise<TruePulseNumber[]> {
  const body = await callApi('/numbers', { method: 'GET' });
  return (Array.isArray(body?.data) ? body.data : [])
    .filter((n: any) => Number.isInteger(n?.id) && typeof n?.phoneNumber === 'string')
    .map((n: any) => ({ id: n.id, phone: n.phoneNumber, label: n.label ?? n.phoneNumber }));
}

/**
 * Asks True Pulse to ring `userId`'s phone, then the lead. Returns what happened in plain words.
 * A sandbox key places no real call (True Pulse answers with a notice instead).
 */
export async function startCall(leadId: string, userId: string, which: 'phone' | 'phone2' = 'phone') {
  const number = await truePulseNumberFor(userId);
  if (!number) throw new TruePulseError(400, 'You don\'t have a True Pulse number yet. Ask your Branch Head to set it in Admin → True Pulse Calling.');
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, leadId: true, phone: true, phone2: true } });
  if (!lead) throw new TruePulseError(404, 'Lead not found');
  const customerNumber = toE164(which === 'phone2' ? lead.phone2 : lead.phone);
  if (!customerNumber) throw new TruePulseError(400, 'This lead\'s phone number doesn\'t look complete, so it can\'t be called.');

  const body = await callApi('', { method: 'POST', body: JSON.stringify({ customerNumber, trackingNumberId: number.id }) });
  const refno = body?.data?.refno != null ? String(body.data.refno) : null;
  const sandbox = !body?.data && /sandbox/i.test(String(body?.message ?? ''));
  await prisma.truePulseCall.create({
    data: {
      refno, leadId: lead.id, userId, direction: 'OUTGOING', status: sandbox ? 'SANDBOX' : 'QUEUED',
      customerNumber, didNumber: number.phone, raw: body ?? undefined,
    },
  });
  await logActivity(userId, 'TRUE_PULSE_CALL_STARTED', lead.id, { refno, sandbox, from: number.phone });
  return {
    refno, sandbox,
    message: sandbox
      ? 'Test mode: True Pulse accepted the request but placed no real call.'
      : 'Your phone will ring now. Answer it and True Pulse will connect you to the client.',
  };
}

// ── Call results from True Pulse ─────────────────────────────────────────────

export function callTokenOk(header: string | undefined): 'ok' | 'unconfigured' | 'bad' {
  const expected = process.env.TRUEPULSE_CALL_TOKEN ?? '';
  if (!expected) return 'unconfigured';
  if (!header?.startsWith('Bearer ')) return 'bad';
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'bad';
}

const pick = (b: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = b[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
};

function toDate(v: string): Date | null {
  if (!v) return null;
  const d = /^\d{12,}$/.test(v) ? new Date(Number(v)) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type CallResult = {
  tpCallId: string; refno: string | null; customerNumber: string; didNumber: string | null;
  status: 'ANSWERED' | 'MISSED' | 'UNKNOWN'; direction: 'INCOMING' | 'OUTGOING' | null;
  startedAt: Date | null; endedAt: Date | null; durationSecs: number | null;
  agentName: string | null; agentPhone: string | null; recordingUrl: string | null;
};

/**
 * Reads a call result. Field names follow True Pulse's own call format
 * (tpCallID, tpCallerNumber, tpCallStatus, tpCallType, …) plus `refno` for calls
 * started from the CRM; common plain names are accepted too.
 */
export function parseCallResult(b: Record<string, unknown>): CallResult | { error: string } {
  const tpCallId = pick(b, 'tpCallID', 'tpCallId', 'callId', 'callID');
  const customerNumber = pick(b, 'tpCallerNumber', 'customerNumber', 'callerNumber');
  if (!tpCallId) return { error: 'tpCallID is required' };
  if (!customerNumber) return { error: 'tpCallerNumber (the client\'s number) is required' };
  const rawStatus = pick(b, 'tpCallStatus', 'callStatus', 'status').toUpperCase();
  const status = rawStatus === 'ANSWERED' ? 'ANSWERED' : ['MISSED', 'NOT_ANSWERED', 'NOANSWER', 'NO_ANSWER', 'BUSY', 'FAILED'].includes(rawStatus) ? 'MISSED' : 'UNKNOWN';
  const rawType = pick(b, 'tpCallType', 'callType', 'direction').toUpperCase();
  const direction = /^(INCOMING|INBOUND)$/.test(rawType) ? 'INCOMING' : /^(OUTGOING|OUTBOUND)$/.test(rawType) ? 'OUTGOING' : null;
  const startedAt = toDate(pick(b, 'tpCallStartTime', 'callStartTime', 'startTime'));
  const endedAt = toDate(pick(b, 'tpCallEndTime', 'callEndTime', 'endTime'));
  const talk = Number(pick(b, 'tpLegALegBDuration', 'tpLegBDuration', 'duration', 'callDuration'));
  const durationSecs = Number.isFinite(talk) && talk >= 0 && pick(b, 'tpLegALegBDuration', 'tpLegBDuration', 'duration', 'callDuration')
    ? Math.round(talk)
    : startedAt && endedAt && endedAt >= startedAt ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000) : null;
  const recording = pick(b, 'tpCallRecordingPath', 'recordingUrl', 'callRecordingLink', 'recordingLink');
  return {
    tpCallId, refno: pick(b, 'refno', 'refNo', 'tpRefNo') || null, customerNumber,
    didNumber: pick(b, 'tpDIDNumber', 'didNumber', 'trackingNumber') || null,
    status, direction, startedAt, endedAt, durationSecs,
    agentName: pick(b, 'tpAgentName', 'agentName') || null,
    agentPhone: pick(b, 'tpAgentPhone', 'agentPhone') || null,
    recordingUrl: /^https?:\/\//i.test(recording) ? recording : null,
  };
}

async function systemUserId(): Promise<string | null> {
  return (await prisma.user.findFirst({ where: { role: 'BRANCH_HEAD', isActive: true }, select: { id: true }, orderBy: { createdAt: 'asc' } }))?.id ?? null;
}

/** The lead with this phone number (either of its two numbers), oldest first — the same rule as duplicate checks. */
async function leadForNumber(number: string) {
  const key = phoneKey(number);
  if (key.length < 7) return null;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM leads
    WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${key}
       OR right(regexp_replace(coalesce(phone2, ''), '[^0-9]', '', 'g'), 10) = ${key}
    ORDER BY "createdAt" ASC LIMIT 1`;
  return rows[0] ? prisma.lead.findUnique({ where: { id: rows[0].id }, select: { id: true, leadId: true, name: true, status: true, assignedDesignerId: true, assignedCREId: true, assignedBLId: true } }) : null;
}

/** Whose True Pulse number this is (Admin → True Pulse Calling), matched on the last 10 digits. */
async function userForTrackingNumber(number: string | null): Promise<string | null> {
  if (!number) return null;
  const key = phoneKey(number);
  const { byUser } = await truePulseNumbersConfig.get().catch(() => ({ byUser: {} } as TruePulseNumbers));
  return Object.entries(byUser).find(([, n]) => phoneKey(n.phone) === key)?.[0] ?? null;
}

/**
 * Stores one call result and, when the number belongs to a lead, logs it there:
 * - answered (either way) → an ANSWERED call; outgoing not answered → the next
 *   unanswered attempt (RNR), so escalation keeps working;
 * - incoming not answered → no call row (it is not an attempt by us); the
 *   person handling the lead is alerted to call back;
 * - if the person already typed in this call (within 3 hours), the result is
 *   added to their entry instead of making a second one.
 */
export async function recordCallResult(r: CallResult): Promise<{ status: 'logged' | 'updated' | 'stored' | 'duplicate'; leadId?: string }> {
  const existing = await prisma.truePulseCall.findUnique({ where: { tpCallId: r.tpCallId } });
  if (existing) return { status: 'duplicate' };

  const pending = r.refno ? await prisma.truePulseCall.findFirst({ where: { refno: r.refno, tpCallId: null }, orderBy: { createdAt: 'desc' } }) : null;
  const direction = r.direction ?? (pending ? 'OUTGOING' : null);
  const lead = pending?.leadId
    ? await prisma.lead.findUnique({ where: { id: pending.leadId }, select: { id: true, leadId: true, name: true, status: true, assignedDesignerId: true, assignedCREId: true, assignedBLId: true } })
    : await leadForNumber(r.customerNumber);
  const userId = pending?.userId ?? await userForTrackingNumber(r.didNumber) ?? lead?.assignedDesignerId ?? null;

  const data = {
    tpCallId: r.tpCallId, refno: r.refno, leadId: lead?.id ?? null, userId, direction, status: r.status,
    customerNumber: r.customerNumber, didNumber: r.didNumber, agentName: r.agentName, agentPhone: r.agentPhone,
    startedAt: r.startedAt, endedAt: r.endedAt, durationSecs: r.durationSecs, recordingUrl: r.recordingUrl,
  };
  const row = pending
    ? await prisma.truePulseCall.update({ where: { id: pending.id }, data })
    : await prisma.truePulseCall.create({ data });
  if (!lead) return { status: 'stored' };

  const actor = userId ?? await systemUserId();
  const when = r.startedAt ?? new Date();

  // Incoming and nobody answered: tell the person handling the lead to call back.
  if (direction === 'INCOMING' && r.status === 'MISSED') {
    if (actor) await logActivity(actor, 'TRUE_PULSE_MISSED_CALL', lead.id, { from: r.customerNumber, at: when.toISOString(), tpCallId: r.tpCallId });
    const handler = lead.assignedDesignerId ?? lead.assignedCREId ?? lead.assignedBLId;
    if (handler) await createNotification(handler, 'MISSED_CALL', `Missed call from ${lead.leadId} (${lead.name}). Please call back.`, lead.id);
    return { status: 'stored', leadId: lead.leadId };
  }
  if (r.status === 'UNKNOWN' || !actor) return { status: 'stored', leadId: lead.leadId };

  // Already typed in by the person (shortly before or after the call)? Add the result to it.
  const typed = await prisma.call.findFirst({
    where: {
      leadId: lead.id, source: null, externalCallId: null,
      ...(userId && { loggedById: userId }),
      createdAt: { gte: new Date(when.getTime() - SAME_CALL_WINDOW_MS), lte: new Date(when.getTime() + SAME_CALL_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (typed) {
    await prisma.call.update({
      where: { id: typed.id },
      data: {
        externalCallId: r.tpCallId, direction,
        ...(typed.duration == null && r.durationSecs != null && { duration: r.durationSecs }),
        ...(!typed.recordingUrl && r.recordingUrl && { recordingUrl: r.recordingUrl }),
        ...(!typed.calledAt && r.startedAt && { calledAt: r.startedAt }),
      },
    });
    await prisma.truePulseCall.update({ where: { id: row.id }, data: { callId: typed.id } });
    return { status: 'updated', leadId: lead.leadId };
  }

  let outcome: string = 'ANSWERED';
  if (r.status === 'MISSED') {
    const before = await prisma.call.count({ where: { leadId: lead.id, outcome: { in: [...RNR_OUTCOMES] } } });
    outcome = RNR_OUTCOMES[Math.min(before, RNR_OUTCOMES.length - 1)];
  }
  const call = await prisma.call.create({
    data: {
      leadId: lead.id, loggedById: actor, outcome: outcome as any, duration: r.durationSecs ?? undefined,
      recordingUrl: r.recordingUrl ?? undefined, calledAt: when, source: 'TRUE_PULSE', externalCallId: r.tpCallId, direction,
    },
  });
  await prisma.truePulseCall.update({ where: { id: row.id }, data: { callId: call.id } });
  await logActivity(actor, 'CALL_LOGGED', lead.id, { outcome, duration: r.durationSecs, source: 'TRUE_PULSE', direction });
  return { status: 'logged', leadId: lead.leadId };
}

/**
 * When someone types in a call that True Pulse already logged (within 3 hours),
 * their entry completes that call instead of making a second one.
 */
export async function autoLoggedCallToComplete(leadId: string, userId: string) {
  return prisma.call.findFirst({
    where: { leadId, loggedById: userId, source: 'TRUE_PULSE', notes: null, createdAt: { gte: new Date(Date.now() - SAME_CALL_WINDOW_MS) } },
    orderBy: { createdAt: 'desc' },
  });
}
