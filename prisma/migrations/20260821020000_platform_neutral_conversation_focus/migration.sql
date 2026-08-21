ALTER TABLE "bot_agent_runtime_state"
  DROP COLUMN "qq_conversation_focus",
  ADD COLUMN "conversation_focus" JSONB;
