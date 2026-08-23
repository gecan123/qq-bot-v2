ALTER TABLE "bot_agent_runtime_state"
ADD CONSTRAINT "bot_agent_runtime_state_singleton_check" CHECK ("id" = 1);

ALTER TABLE "bot_agent_checkpoint"
ADD CONSTRAINT "bot_agent_checkpoint_singleton_check" CHECK ("id" = 1);
