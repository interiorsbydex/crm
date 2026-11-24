-- True Pulse calling: where a call came from, and every call result True Pulse sends. Safe to run twice.
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "externalCallId" TEXT;
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "direction" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "calls_externalCallId_key" ON "calls"("externalCallId");

CREATE TABLE IF NOT EXISTS "true_pulse_calls" (
    "id" TEXT NOT NULL,
    "tpCallId" TEXT,
    "refno" TEXT,
    "leadId" TEXT,
    "userId" TEXT,
    "callId" TEXT,
    "direction" TEXT,
    "status" TEXT,
    "customerNumber" TEXT,
    "didNumber" TEXT,
    "agentName" TEXT,
    "agentPhone" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSecs" INTEGER,
    "recordingUrl" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "true_pulse_calls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "true_pulse_calls_tpCallId_key" ON "true_pulse_calls"("tpCallId");
CREATE INDEX IF NOT EXISTS "true_pulse_calls_refno_idx" ON "true_pulse_calls"("refno");
CREATE INDEX IF NOT EXISTS "true_pulse_calls_leadId_idx" ON "true_pulse_calls"("leadId");
