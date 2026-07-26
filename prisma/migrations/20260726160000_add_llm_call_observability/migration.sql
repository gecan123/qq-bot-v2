ALTER TABLE "agent_token_usage"
  ADD COLUMN "call_id" UUID,
  ADD COLUMN "actor" VARCHAR(64),
  ADD COLUMN "provider" VARCHAR(64),
  ADD COLUMN "status" VARCHAR(32) NOT NULL DEFAULT 'succeeded',
  ADD COLUMN "duration_ms" INTEGER,
  ADD COLUMN "stop_reason" VARCHAR(64),
  ADD COLUMN "error_kind" VARCHAR(191),
  ADD COLUMN "goal_id" VARCHAR(191),
  ADD COLUMN "task_id" VARCHAR(191),
  ADD COLUMN "attempt" INTEGER,
  ADD COLUMN "evidence" JSONB;

ALTER TABLE "agent_token_usage"
  ADD CONSTRAINT "agent_token_usage_status_check"
    CHECK ("status" IN ('succeeded', 'failed', 'aborted')),
  ADD CONSTRAINT "agent_token_usage_duration_ms_check"
    CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0),
  ADD CONSTRAINT "agent_token_usage_attempt_check"
    CHECK ("attempt" IS NULL OR "attempt" > 0);

CREATE UNIQUE INDEX "agent_token_usage_call_id_key"
  ON "agent_token_usage" ("call_id");

CREATE INDEX "agent_token_usage_actor_ts_idx"
  ON "agent_token_usage" ("actor", "ts" DESC);

CREATE INDEX "agent_token_usage_provider_ts_idx"
  ON "agent_token_usage" ("provider", "ts" DESC);

CREATE INDEX "agent_token_usage_status_ts_idx"
  ON "agent_token_usage" ("status", "ts" DESC);
