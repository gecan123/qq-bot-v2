ALTER TABLE "bot_agent_runtime_state"
DROP COLUMN "active_tool_capabilities";

UPDATE "bot_agent_runtime_state"
SET "schema_version" = 4;
