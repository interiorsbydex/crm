-- Adds an optional field marking a FollowUpTask as a scheduled call (vs. a
-- generic follow-up or callback), storing which call stage it's for
-- (DQL/PP/PD/etc., same vocabulary as MeetingType).
ALTER TABLE "follow_up_tasks" ADD COLUMN IF NOT EXISTS "callStageType" TEXT;
