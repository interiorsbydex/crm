-- CreateEnum
CREATE TYPE "Role" AS ENUM ('DESIGNER', 'CRE', 'BL', 'BRANCH_HEAD');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'ONBOARDING', 'HANDED_OVER', 'INACTIVE', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('ANSWERED', 'RNR_1', 'RNR_2', 'RNR_3', 'RNR_4', 'RNR_5', 'CALLBACK');

-- CreateEnum
CREATE TYPE "MeetingType" AS ENUM ('DQL', 'PP');

-- CreateEnum
CREATE TYPE "MeetingMode" AS ENUM ('EC_VISIT', 'SITE_VISIT', 'VIRTUAL', 'PUBLIC_PLACE');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'RESCHEDULED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "DiscountStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "PerformanceTier" AS ENUM ('BASIC', 'STANDARD', 'PREMIUM');

-- CreateEnum
CREATE TYPE "AssignmentPath" AS ENUM ('STANDARD', 'DIRECT');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'SELECT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "supabaseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "blId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "totalLeadsAssigned" INTEGER NOT NULL DEFAULT 0,
    "totalLeadsConverted" INTEGER NOT NULL DEFAULT 0,
    "avgProjectValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "performanceTier" "PerformanceTier" NOT NULL DEFAULT 'BASIC',

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_counter" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastNum" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "lead_counter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phone2" TEXT,
    "email" TEXT,
    "source" TEXT,
    "adName" TEXT,
    "utmCampaign" TEXT,
    "utmAdSet" TEXT,
    "utmSource" TEXT,
    "projectType" TEXT,
    "scope" TEXT,
    "location" TEXT,
    "possessionTimeline" TEXT,
    "estimatedValue" DECIMAL(12,2),
    "intentRating" INTEGER,
    "stage" "LeadStage" NOT NULL DEFAULT 'EFFECTIVE_LEAD',
    "onHoldRevivalDate" TIMESTAMP(3),
    "isDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "assignedDesignerId" TEXT,
    "assignedBLId" TEXT,
    "currentOfferId" TEXT,
    "assignmentPath" "AssignmentPath" NOT NULL DEFAULT 'STANDARD',
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "daysLeadToDQL" INTEGER,
    "daysDQLToPP" INTEGER,
    "daysPPToOnboarding" INTEGER,
    "isSLABreached" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "loggedById" TEXT NOT NULL,
    "outcome" "CallOutcome" NOT NULL,
    "duration" INTEGER,
    "notes" TEXT,
    "recordingUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up_tasks" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "assignedToId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "dueTime" TEXT,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "isOverdue" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_up_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "MeetingType" NOT NULL,
    "ppNumber" INTEGER,
    "mode" "MeetingMode" NOT NULL,
    "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "rescheduledReason" TEXT,
    "mom" TEXT,
    "outcome" TEXT,
    "confirmationSent" BOOLEAN NOT NULL DEFAULT false,
    "momSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "quoteBuilderRef" TEXT,
    "amount" DECIMAL(12,2),
    "discountPct" DECIMAL(5,2),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_requests" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "quoteId" TEXT,
    "requestedById" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "originalAmount" DECIMAL(12,2) NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DiscountStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewerComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "discount_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "templateId" TEXT,
    "sentById" TEXT,
    "twilioSid" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sentTo" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previewedById" TEXT,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_breaches" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "breachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "sla_breaches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_offers" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inactivation_feedback" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "formToken" TEXT,
    "feedbackFormSentAt" TIMESTAMP(3),
    "clientResponse" TEXT,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "inactivation_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_schedules" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "recipients" TEXT[],
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "leadId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_logs" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "toPhone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "twilioSid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fieldType" "FieldType" NOT NULL,
    "selectOptions" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intent_rating_config" (
    "rating" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6b7280',

    CONSTRAINT "intent_rating_config_pkey" PRIMARY KEY ("rating")
);

-- CreateTable
CREATE TABLE "dql_questionnaires" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "formResponseId" TEXT,
    "responses" JSONB NOT NULL DEFAULT '{}',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dql_questionnaires_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "name" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dip_checklists" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "welcomeMailSent" BOOLEAN NOT NULL DEFAULT false,
    "discountApprovalFormSent" BOOLEAN NOT NULL DEFAULT false,
    "npsTriggered" BOOLEAN NOT NULL DEFAULT false,
    "cxApprovalReceived" BOOLEAN NOT NULL DEFAULT false,
    "internalMailThreadUrl" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dip_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_config" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_supabaseId_key" ON "users"("supabaseId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "leads_leadId_key" ON "leads"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "inactivation_feedback_leadId_key" ON "inactivation_feedback"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "inactivation_feedback_formToken_key" ON "inactivation_feedback"("formToken");

-- CreateIndex
CREATE INDEX "activity_logs_leadId_idx" ON "activity_logs"("leadId");

-- CreateIndex
CREATE INDEX "activity_logs_userId_idx" ON "activity_logs"("userId");

-- CreateIndex
CREATE INDEX "notification_logs_userId_isRead_idx" ON "notification_logs"("userId", "isRead");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_key_key" ON "custom_field_definitions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "dql_questionnaires_leadId_key" ON "dql_questionnaires"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "user_invites_token_key" ON "user_invites"("token");

-- CreateIndex
CREATE UNIQUE INDEX "dip_checklists_leadId_key" ON "dip_checklists"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_config_key_key" ON "assignment_config"("key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_blId_fkey" FOREIGN KEY ("blId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assignedDesignerId_fkey" FOREIGN KEY ("assignedDesignerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assignedBLId_fkey" FOREIGN KEY ("assignedBLId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_currentOfferId_fkey" FOREIGN KEY ("currentOfferId") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_loggedById_fkey" FOREIGN KEY ("loggedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_previewedById_fkey" FOREIGN KEY ("previewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_breaches" ADD CONSTRAINT "sla_breaches_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_offers" ADD CONSTRAINT "lead_offers_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_offers" ADD CONSTRAINT "lead_offers_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inactivation_feedback" ADD CONSTRAINT "inactivation_feedback_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dql_questionnaires" ADD CONSTRAINT "dql_questionnaires_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dip_checklists" ADD CONSTRAINT "dip_checklists_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
