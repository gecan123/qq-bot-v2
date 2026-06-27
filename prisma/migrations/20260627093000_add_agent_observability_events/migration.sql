-- Agent observability event store: raw tool-call and token/cache events.
-- Runtime writes are best-effort; query-side metrics aggregate these rows.

CREATE TABLE "agent_tool_calls" (
  "id" BIGSERIAL NOT NULL,
  "ts" TIMESTAMPTZ(3) NOT NULL,
  "tool_call_id" VARCHAR(191) NOT NULL,
  "tool_name" VARCHAR(191) NOT NULL,
  "round_index" INTEGER NOT NULL,
  "args_summary" JSONB NOT NULL,
  "duration_ms" INTEGER NOT NULL,
  "ok" BOOLEAN NOT NULL,
  "side_effect" BOOLEAN NOT NULL,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_tool_calls_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_tool_calls_ts_idx"
  ON "agent_tool_calls" ("ts" DESC);

CREATE INDEX "agent_tool_calls_tool_name_ts_idx"
  ON "agent_tool_calls" ("tool_name", "ts" DESC);

CREATE INDEX "agent_tool_calls_ok_ts_idx"
  ON "agent_tool_calls" ("ok", "ts" DESC);

CREATE INDEX "agent_tool_calls_side_effect_ts_idx"
  ON "agent_tool_calls" ("side_effect", "ts" DESC);

CREATE TABLE "agent_token_usage" (
  "id" BIGSERIAL NOT NULL,
  "ts" TIMESTAMPTZ(3) NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "round_index" INTEGER,
  "model" VARCHAR(191) NOT NULL,
  "input_tokens" INTEGER,
  "cached_tokens" INTEGER,
  "output_tokens" INTEGER,
  "cache_hit_rate" DOUBLE PRECISION,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_token_usage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_token_usage_ts_idx"
  ON "agent_token_usage" ("ts" DESC);

CREATE INDEX "agent_token_usage_operation_ts_idx"
  ON "agent_token_usage" ("operation", "ts" DESC);

CREATE INDEX "agent_token_usage_model_ts_idx"
  ON "agent_token_usage" ("model", "ts" DESC);
