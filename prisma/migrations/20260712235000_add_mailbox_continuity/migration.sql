ALTER TABLE "bot_agent_snapshot"
ADD COLUMN "mailbox_continuity" JSONB NOT NULL DEFAULT '{}';
