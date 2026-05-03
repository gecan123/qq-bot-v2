-- single-context MVP: drop legacy per-scene runtime tables + add BotAgentSnapshot

DROP TABLE IF EXISTS "assistant_turns";
DROP TABLE IF EXISTS "reply_audits";
DROP TABLE IF EXISTS "agent_runtime_snapshots";
DROP TABLE IF EXISTS "scene_agent_contexts";
DROP TABLE IF EXISTS "scenes";
DROP TABLE IF EXISTS "runtime_events";
DROP TABLE IF EXISTS "opportunities";
DROP TABLE IF EXISTS "action_intents";
DROP TABLE IF EXISTS "decisions";
DROP TABLE IF EXISTS "action_records";
DROP TABLE IF EXISTS "memory_items";
DROP TABLE IF EXISTS "memory_proposals";
DROP TABLE IF EXISTS "self_spine_update_proposals";
DROP TABLE IF EXISTS "self_spine_versions";
DROP TABLE IF EXISTS "feed_sources";
DROP TABLE IF EXISTS "feed_items";
DROP TABLE IF EXISTS "read_sessions";
DROP TABLE IF EXISTS "read_session_reviews";
DROP TABLE IF EXISTS "source_summaries";
DROP TABLE IF EXISTS "thought_artifacts";
DROP TABLE IF EXISTS "rationale_artifacts";
DROP TABLE IF EXISTS "inner_journal";

-- llm_traces: drop scene/opportunity/frame columns since per-scene tracking is gone
ALTER TABLE "llm_traces" DROP COLUMN IF EXISTS "frame_id";
ALTER TABLE "llm_traces" DROP COLUMN IF EXISTS "scene_id";
ALTER TABLE "llm_traces" DROP COLUMN IF EXISTS "opportunity_id";
ALTER TABLE "llm_traces" DROP COLUMN IF EXISTS "context_frame";
DROP INDEX IF EXISTS "llm_traces_frame_id_loop_index_idx";
DROP INDEX IF EXISTS "llm_traces_scene_id_opportunity_id_idx";

-- new table: BotAgentSnapshot — single row, single bot, single context
CREATE TABLE "bot_agent_snapshot" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "context_snapshot" JSONB NOT NULL,
    "last_wake_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_agent_snapshot_pkey" PRIMARY KEY ("id")
);
