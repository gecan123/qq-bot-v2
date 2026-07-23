-- Non-canonical LLM request/response evidence for diagnostics and WebAdmin.
-- This table is observability only and must never participate in AgentContext replay.

CREATE TABLE "agent_llm_calls" (
  "id" BIGSERIAL NOT NULL,
  "call_id" UUID NOT NULL,
  "ts" TIMESTAMPTZ(3) NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "round_index" INTEGER,
  "provider" VARCHAR(32) NOT NULL,
  "model" VARCHAR(191) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "duration_ms" INTEGER NOT NULL,
  "canonical_request" JSONB NOT NULL,
  "wire_request" JSONB,
  "canonical_response" JSONB,
  "wire_response" JSONB,
  "request_id" VARCHAR(191),
  "http_status" INTEGER,
  "input_tokens" INTEGER,
  "cached_tokens" INTEGER,
  "output_tokens" INTEGER,
  "stop_reason" VARCHAR(64),
  "error" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_llm_calls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_llm_calls_call_id_key" UNIQUE ("call_id")
);

CREATE INDEX "agent_llm_calls_ts_idx" ON "agent_llm_calls" ("ts" DESC);
CREATE INDEX "agent_llm_calls_operation_ts_idx" ON "agent_llm_calls" ("operation", "ts" DESC);
CREATE INDEX "agent_llm_calls_provider_model_ts_idx" ON "agent_llm_calls" ("provider", "model", "ts" DESC);
CREATE INDEX "agent_llm_calls_status_ts_idx" ON "agent_llm_calls" ("status", "ts" DESC);
