ALTER TABLE "bot_agent_snapshot"
ADD COLUMN "goal_revision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "bot_agent_goal" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "goal_id" UUID NOT NULL,
    "objective" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "token_budget" INTEGER,
    "tokens_used" INTEGER NOT NULL DEFAULT 0,
    "time_used_seconds" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "source_message_row_id" INTEGER,
    "last_control_message_row_id" INTEGER,
    "blocker_key" VARCHAR(120),
    "blocker_turns" INTEGER NOT NULL DEFAULT 0,
    "last_blocker_round" INTEGER,
    "blocked_reason" TEXT,
    "completion_evidence" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_agent_goal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bot_agent_goal_singleton" CHECK ("id" = 1),
    CONSTRAINT "bot_agent_goal_status_check" CHECK ("status" IN (
        'active',
        'paused',
        'blocked',
        'budget_limited',
        'usage_limited',
        'complete',
        'cancelled'
    )),
    CONSTRAINT "bot_agent_goal_token_budget_check" CHECK ("token_budget" IS NULL OR "token_budget" > 0),
    CONSTRAINT "bot_agent_goal_usage_check" CHECK ("tokens_used" >= 0 AND "time_used_seconds" >= 0),
    CONSTRAINT "bot_agent_goal_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "bot_agent_goal_blocker_turns_check" CHECK ("blocker_turns" >= 0)
);

CREATE UNIQUE INDEX "bot_agent_goal_goal_id_key" ON "bot_agent_goal"("goal_id");
