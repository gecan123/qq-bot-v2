DROP TABLE IF EXISTS "bot_agent_goal";

ALTER TABLE "bot_agent_runtime_state"
  DROP COLUMN IF EXISTS "goal_revision";

ALTER TABLE "agent_token_usage"
  DROP COLUMN IF EXISTS "goal_id";
