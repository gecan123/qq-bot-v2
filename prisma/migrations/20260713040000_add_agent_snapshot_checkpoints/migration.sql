CREATE TABLE "bot_agent_snapshot_checkpoints" (
    "id" BIGSERIAL NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "context_snapshot" JSONB NOT NULL,
    "mailbox_cursors" JSONB NOT NULL,
    "mailbox_continuity" JSONB NOT NULL,
    "goal_revision" INTEGER NOT NULL,
    "last_wake_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_agent_snapshot_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bot_agent_snapshot_checkpoints_created_at_idx"
ON "bot_agent_snapshot_checkpoints"("created_at" DESC);
