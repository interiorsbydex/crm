import { prisma } from './prisma.js';

export type CommercialContext = {
  budget: number | null;
  intent: number | null;
  projectValue: number | null;
};

export type StageChangeRecord = {
  createdAt: Date;
  meta: unknown;
};

export type StageTimelineVisit = {
  stage: string;
  enteredAt: Date;
  exitedAt?: Date;
  tatDays: number;
  commercialContext?: CommercialContext;
};

type StageChangeMeta = {
  from?: string;
  to?: string;
  fromCommercialContext?: unknown;
  toCommercialContext?: unknown;
};

type CommercialContextSource = {
  estimatedValue: unknown;
  intentRating: number | null;
  project?: { contractValue: unknown } | null;
  pdObChecklist?: { projectValue: unknown } | null;
  quotes?: Array<{ amount: unknown }>;
};

const asNumberOrNull = (value: unknown): number | null => value == null ? null : Number(value);

/** Uses the most specific available costing source for a point-in-time snapshot. */
export function resolveCommercialContext(record: CommercialContextSource): CommercialContext {
  return {
    budget: asNumberOrNull(record.estimatedValue),
    intent: record.intentRating ?? null,
    projectValue: asNumberOrNull(
      record.quotes?.[0]?.amount
      ?? record.pdObChecklist?.projectValue
      ?? record.project?.contractValue
      ?? record.estimatedValue,
    ),
  };
}

/** Loads the current commercial context used when a stage transition is recorded. */
export async function getCommercialContextForLead(leadId: string): Promise<CommercialContext | null> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      estimatedValue: true,
      intentRating: true,
      project: { select: { contractValue: true } },
      pdObChecklist: { select: { projectValue: true } },
      quotes: {
        select: { amount: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });
  return lead ? resolveCommercialContext(lead) : null;
}

export function isCommercialContext(value: unknown): value is CommercialContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  return ['budget', 'intent', 'projectValue'].every(
    (key) => context[key] === null || typeof context[key] === 'number',
  );
}

export function buildStageTimelineHistory({
  leadStage,
  createdAt,
  stageLogs,
  currentCommercialContext,
  now = new Date(),
}: {
  leadStage: string;
  createdAt: Date;
  stageLogs: StageChangeRecord[];
  currentCommercialContext: CommercialContext;
  now?: Date;
}): StageTimelineVisit[] {
  const history: StageTimelineVisit[] = [];
  const firstMeta = stageLogs[0]?.meta as StageChangeMeta | null;
  let currentStage = firstMeta?.from ?? leadStage;
  let currentEnteredAt = createdAt;
  let currentCommercialSnapshot = isCommercialContext(firstMeta?.fromCommercialContext)
    ? firstMeta.fromCommercialContext
    : undefined;

  for (const log of stageLogs) {
    const meta = log.meta as StageChangeMeta | null;
    if (!meta?.to) continue;
    const tatDays = Math.max(0, Math.floor((log.createdAt.getTime() - currentEnteredAt.getTime()) / 86_400_000));
    history.push({
      stage: currentStage,
      enteredAt: currentEnteredAt,
      exitedAt: log.createdAt,
      tatDays,
      commercialContext: isCommercialContext(meta.fromCommercialContext)
        ? meta.fromCommercialContext
        : currentCommercialSnapshot,
    });
    currentStage = meta.to;
    currentEnteredAt = log.createdAt;
    currentCommercialSnapshot = isCommercialContext(meta.toCommercialContext)
      ? meta.toCommercialContext
      : undefined;
  }

  history.push({
    stage: currentStage,
    enteredAt: currentEnteredAt,
    tatDays: Math.max(0, Math.floor((now.getTime() - currentEnteredAt.getTime()) / 86_400_000)),
    commercialContext: currentCommercialSnapshot
      ?? (currentStage === leadStage ? currentCommercialContext : undefined),
  });

  return history;
}