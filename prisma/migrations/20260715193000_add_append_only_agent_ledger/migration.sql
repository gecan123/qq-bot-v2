-- Clean cutover: the previous mutable snapshot is deliberately not migrated.
DROP TABLE IF EXISTS "bot_agent_snapshot_checkpoints";
DROP TABLE IF EXISTS "bot_agent_snapshot";

CREATE TABLE "bot_agent_ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "entry_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_agent_ledger_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bot_agent_ledger_entries_entry_type_check"
        CHECK ("entry_type" IN ('message', 'compaction'))
);

CREATE INDEX "bot_agent_ledger_entries_entry_type_id_idx"
ON "bot_agent_ledger_entries"("entry_type", "id");

CREATE TABLE "bot_agent_runtime_state" (
    "id" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "mailbox_cursors" JSONB NOT NULL,
    "mailbox_continuity" JSONB NOT NULL,
    "goal_revision" INTEGER NOT NULL,
    "active_tool_capabilities" JSONB NOT NULL,
    "last_wake_at" TIMESTAMPTZ(6),
    "ledger_head_entry_id" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_agent_runtime_state_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bot_agent_checkpoint" (
    "id" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "through_entry_id" BIGINT,
    "fingerprint" TEXT NOT NULL,
    "projection" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_agent_checkpoint_pkey" PRIMARY KEY ("id")
);

INSERT INTO "bot_agent_runtime_state" (
    "id",
    "schema_version",
    "mailbox_cursors",
    "mailbox_continuity",
    "goal_revision",
    "active_tool_capabilities",
    "last_wake_at",
    "ledger_head_entry_id"
) VALUES (
    1,
    1,
    '{}'::jsonb,
    '{"schemaVersion":1,"roundSeq":0,"lastInputTokens":null,"compactionEpoch":0,"mailboxes":{}}'::jsonb,
    0,
    '[]'::jsonb,
    NULL,
    NULL
);

-- Goals are control state tied to the discarded prompt history.
DELETE FROM "bot_agent_goal";
