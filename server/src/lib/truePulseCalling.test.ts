import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from './prisma.js';
import { autoLoggedCallToComplete, parseCallResult, recordCallResult, startCall, toE164, truePulseNumbersConfig, type CallResult } from './truePulseCalling.js';

const safeDb = /@localhost:\d+\//.test(process.env.DATABASE_URL ?? '');

describe('True Pulse phone numbers', () => {
  it('writes numbers the way True Pulse expects', () => {
    expect(toE164('98765 43210')).toBe('+919876543210');
    expect(toE164('+91 98765-43210')).toBe('+919876543210');
    expect(toE164('919876543210')).toBe('+919876543210');
    expect(toE164('09876543210')).toBe('+919876543210');
    expect(toE164('+971 50 123 4567')).toBe('+971501234567');
    expect(toE164('12345')).toBeNull();
    expect(toE164(null)).toBeNull();
  });
});

describe('True Pulse call results', () => {
  it('reads True Pulse\'s own call format', () => {
    const r = parseCallResult({
      tpCallID: 'C1', tpCallerNumber: '+919876543210', tpDIDNumber: '+914440000000', tpCallStatus: 'ANSWERED',
      tpCallType: 'OUTGOING', tpCallStartTime: '2026-11-24T10:30:00Z', tpCallEndTime: '2026-11-24T10:34:52Z',
      tpAgentName: 'Priya', tpCallRecordingPath: 'https://rec.example/1.mp3', refno: 1042,
    }) as CallResult;
    expect(r).toMatchObject({ tpCallId: 'C1', refno: '1042', status: 'ANSWERED', direction: 'OUTGOING', durationSecs: 292, recordingUrl: 'https://rec.example/1.mp3' });
  });
  it('prefers the talk time when given, and refuses results without a call ID or number', () => {
    expect((parseCallResult({ tpCallID: 'C2', tpCallerNumber: '9876543210', tpCallStatus: 'MISSED', tpLegALegBDuration: '0' }) as CallResult).durationSecs).toBe(0);
    expect((parseCallResult({ tpCallID: 'C3', tpCallerNumber: '9876543210', tpCallStatus: 'weird' }) as CallResult).status).toBe('UNKNOWN');
    expect(parseCallResult({ tpCallerNumber: '9876543210' })).toEqual({ error: 'tpCallID is required' });
    expect('error' in parseCallResult({ tpCallID: 'C4' })).toBe(true);
  });
  it('keeps only web links as recordings', () => {
    expect((parseCallResult({ tpCallID: 'C5', tpCallerNumber: '9876543210', tpCallRecordingPath: 'javascript:alert(1)' }) as CallResult).recordingUrl).toBeNull();
  });
});

describe.skipIf(!safeDb)('logging True Pulse call results on leads', () => {
  const tag = `tpc${Date.now()}`;
  const phone = `+9193${String(Date.now()).slice(-8)}`;
  let designerId = '';
  let leadDbId = '';
  const result = (over: Partial<CallResult>): CallResult => ({
    tpCallId: `${tag}-${Math.random().toString(36).slice(2)}`, refno: null, customerNumber: phone, didNumber: null,
    status: 'ANSWERED', direction: 'OUTGOING', startedAt: new Date(), endedAt: new Date(), durationSecs: 60,
    agentName: null, agentPhone: null, recordingUrl: 'https://rec.example/x.mp3', ...over,
  });

  beforeAll(async () => {
    designerId = (await prisma.user.create({ data: { name: 'TP Designer', email: `${tag}@x.test`, supabaseId: tag, role: 'DESIGNER' } })).id;
    leadDbId = (await prisma.lead.create({ data: { leadId: `T${tag}`.slice(0, 20), name: 'TP Lead', phone, assignedDesignerId: designerId } })).id;
  });
  afterAll(async () => {
    await prisma.truePulseCall.deleteMany({ where: { OR: [{ leadId: leadDbId }, { tpCallId: { startsWith: tag } }] } });
    await prisma.notificationLog.deleteMany({ where: { userId: designerId } });
    await prisma.activityLog.deleteMany({ where: { OR: [{ userId: designerId }, { leadId: leadDbId }] } });
    await prisma.call.deleteMany({ where: { leadId: leadDbId } });
    await prisma.lead.deleteMany({ where: { id: leadDbId } });
    await prisma.user.delete({ where: { id: designerId } });
    await prisma.$disconnect();
  });

  it('logs a call started from the CRM on that lead, for the person who pressed Call', async () => {
    await prisma.truePulseCall.create({ data: { refno: `${tag}-ref`, leadId: leadDbId, userId: designerId, direction: 'OUTGOING', status: 'QUEUED' } });
    const r = result({ refno: `${tag}-ref`, direction: null });
    expect(await recordCallResult(r)).toMatchObject({ status: 'logged' });
    const call = await prisma.call.findUnique({ where: { externalCallId: r.tpCallId } });
    expect(call).toMatchObject({ leadId: leadDbId, loggedById: designerId, outcome: 'ANSWERED', duration: 60, source: 'TRUE_PULSE', direction: 'OUTGOING' });
    expect(await prisma.truePulseCall.count({ where: { refno: `${tag}-ref` } })).toBe(1);
    // The same result twice is harmless.
    expect(await recordCallResult(r)).toEqual({ status: 'duplicate' });
  });

  it('counts unanswered outgoing calls as attempts (RNR), one after another', async () => {
    await recordCallResult(result({ status: 'MISSED', durationSecs: 0 }));
    await recordCallResult(result({ status: 'MISSED', durationSecs: 0 }));
    const outcomes = (await prisma.call.findMany({ where: { leadId: leadDbId, outcome: { in: ['RNR_1', 'RNR_2'] } }, orderBy: { createdAt: 'asc' } })).map((c) => c.outcome);
    expect(outcomes).toEqual(['RNR_1', 'RNR_2']);
  });

  it('turns a missed incoming call into a call-back alert, not an attempt', async () => {
    const before = await prisma.call.count({ where: { leadId: leadDbId } });
    await recordCallResult(result({ status: 'MISSED', direction: 'INCOMING', durationSecs: 0 }));
    expect(await prisma.call.count({ where: { leadId: leadDbId } })).toBe(before);
    expect(await prisma.notificationLog.count({ where: { userId: designerId, type: 'MISSED_CALL' } })).toBe(1);
  });

  it('keeps calls from numbers that are not a lead, without logging them anywhere', async () => {
    const r = result({ customerNumber: '+919000000077' });
    expect(await recordCallResult(r)).toEqual({ status: 'stored' });
    expect(await prisma.truePulseCall.findUnique({ where: { tpCallId: r.tpCallId } })).toMatchObject({ leadId: null });
  });

  it('adds the result to a call the person already typed in, instead of logging it twice', async () => {
    const typed = await prisma.call.create({ data: { leadId: leadDbId, loggedById: designerId, outcome: 'ANSWERED', notes: 'Spoke about kitchen' } });
    const r = result({ durationSecs: 120 });
    // Pretend True Pulse's pending row tells us who called.
    await prisma.truePulseCall.create({ data: { refno: `${tag}-ref2`, leadId: leadDbId, userId: designerId, direction: 'OUTGOING', status: 'QUEUED' } });
    expect(await recordCallResult({ ...r, refno: `${tag}-ref2` })).toMatchObject({ status: 'updated' });
    expect(await prisma.call.findUnique({ where: { id: typed.id } })).toMatchObject({ externalCallId: r.tpCallId, duration: 120, recordingUrl: 'https://rec.example/x.mp3', notes: 'Spoke about kitchen' });
  });

  it('lets the person complete an automatically logged call with their notes', async () => {
    const auto = await autoLoggedCallToComplete(leadDbId, designerId);
    expect(auto).toMatchObject({ source: 'TRUE_PULSE', notes: null });
  });

  it('starts a call from the person\'s own True Pulse number (True Pulse simulated)', async () => {
    const saved = await truePulseNumbersConfig.state();
    await truePulseNumbersConfig.save({ byUser: { [designerId]: { id: 12, phone: '+914440000012' } } }, saved.revision, designerId);
    const sent: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      sent.push({ url, body: JSON.parse(init.body), key: init.headers.Authorization });
      return new Response(JSON.stringify({ status: 'SUCCESS', message: 'Call queued successfully', data: { refno: `${tag}-777`, status: 'QUEUED' } }), { status: 200 });
    });
    const oldKey = process.env.TRUEPULSE_OUTBOUND_KEY;
    try {
      delete process.env.TRUEPULSE_OUTBOUND_KEY;
      await expect(startCall(leadDbId, designerId)).rejects.toThrow(/not set up yet/);
      process.env.TRUEPULSE_OUTBOUND_KEY = 'tp_out_test';
      const r = await startCall(leadDbId, designerId);
      expect(r).toMatchObject({ refno: `${tag}-777`, sandbox: false });
      expect(sent[0]).toMatchObject({ body: { customerNumber: phone, trackingNumberId: 12 }, key: 'Bearer tp_out_test' });
      expect(await prisma.truePulseCall.findFirst({ where: { refno: `${tag}-777` } })).toMatchObject({ leadId: leadDbId, userId: designerId, status: 'QUEUED' });
    } finally {
      vi.unstubAllGlobals();
      if (oldKey === undefined) delete process.env.TRUEPULSE_OUTBOUND_KEY; else process.env.TRUEPULSE_OUTBOUND_KEY = oldKey;
      await truePulseNumbersConfig.reset(designerId);
      await prisma.activityLog.deleteMany({ where: { userId: designerId } });
    }
  });

  it('refuses two people on the same True Pulse number', async () => {
    const other = await prisma.user.create({ data: { name: 'TP Other', email: `${tag}b@x.test`, supabaseId: `${tag}b`, role: 'DESIGNER' } });
    try {
      const st = await truePulseNumbersConfig.state();
      await expect(truePulseNumbersConfig.save({ byUser: { [designerId]: { id: 5, phone: '+91444' }, [other.id]: { id: 5, phone: '+91444' } } }, st.revision, designerId))
        .rejects.toMatchObject({ problems: [expect.stringContaining('same True Pulse number')] });
    } finally {
      await prisma.user.delete({ where: { id: other.id } });
    }
  });
});
