ALTER TABLE "bot_agent_runtime_state"
ADD COLUMN "inbox_read_cursors" JSONB NOT NULL DEFAULT '{}';

UPDATE "bot_agent_runtime_state"
SET
  "inbox_read_cursors" = "mailbox_cursors",
  "schema_version" = 3
WHERE "id" = 1;
