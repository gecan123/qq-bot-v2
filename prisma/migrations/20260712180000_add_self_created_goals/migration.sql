ALTER TABLE "bot_agent_goal"
ADD COLUMN "origin" VARCHAR(16) NOT NULL DEFAULT 'owner',
ADD COLUMN "motivation" TEXT,
ADD COLUMN "completion_criteria" JSONB,
ADD COLUMN "self_goal_window_started_at" TIMESTAMPTZ(3),
ADD COLUMN "self_goal_window_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_self_goal_created_at" TIMESTAMPTZ(3);

ALTER TABLE "bot_agent_goal"
DROP CONSTRAINT "bot_agent_goal_status_check";

ALTER TABLE "bot_agent_goal"
ADD CONSTRAINT "bot_agent_goal_status_check" CHECK ("status" IN (
    'active',
    'paused',
    'blocked',
    'budget_limited',
    'usage_limited',
    'complete',
    'cancelled',
    'abandoned'
)),
ADD CONSTRAINT "bot_agent_goal_origin_check" CHECK ("origin" IN ('owner', 'self')),
ADD CONSTRAINT "bot_agent_goal_self_window_count_check" CHECK ("self_goal_window_count" >= 0);
