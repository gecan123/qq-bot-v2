ALTER TABLE "bot_agent_snapshot"
  ALTER COLUMN "updated_at" DROP DEFAULT,
  ADD COLUMN "mailbox_cursors" JSONB NOT NULL DEFAULT '{}';
