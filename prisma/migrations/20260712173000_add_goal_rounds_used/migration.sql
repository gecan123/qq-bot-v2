ALTER TABLE "bot_agent_goal"
ADD COLUMN "rounds_used" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "bot_agent_goal"
ADD CONSTRAINT "bot_agent_goal_rounds_used_check" CHECK ("rounds_used" >= 0);
