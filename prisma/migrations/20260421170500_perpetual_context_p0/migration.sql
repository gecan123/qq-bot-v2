DROP TABLE IF EXISTS "context_entries";
DROP TABLE IF EXISTS "conversations";
DROP TABLE IF EXISTS "group_memory_cursor";
DROP TABLE IF EXISTS "group_memory";
DROP TABLE IF EXISTS "user_memory";

CREATE TABLE "conversation_states" (
  "id" SERIAL NOT NULL,
  "group_id" BIGINT NOT NULL,
  "sender_thread_key" VARCHAR(128) NOT NULL,
  "compacted_base" TEXT NOT NULL DEFAULT '',
  "compacted_version" INTEGER NOT NULL DEFAULT 1,
  "last_compacted_message_row_id" INTEGER,
  "last_incorporated_message_row_id" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "conversation_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assistant_turns" (
  "id" SERIAL NOT NULL,
  "group_id" BIGINT NOT NULL,
  "sender_thread_key" VARCHAR(128) NOT NULL,
  "reply_intent_id" VARCHAR(191) NOT NULL,
  "trigger_message_row_id" INTEGER NOT NULL,
  "incorporated_message_row_id" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "reply_to_message_id" BIGINT NOT NULL,
  "mention_user_id" BIGINT,
  "text" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "assistant_turns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_states_group_id_sender_thread_key_key"
  ON "conversation_states"("group_id", "sender_thread_key");

CREATE INDEX "conversation_states_group_id_updated_at_idx"
  ON "conversation_states"("group_id", "updated_at" DESC);

CREATE UNIQUE INDEX "assistant_turns_group_id_sender_thread_key_reply_intent_id_key"
  ON "assistant_turns"("group_id", "sender_thread_key", "reply_intent_id");

CREATE UNIQUE INDEX "assistant_turns_group_id_sender_thread_key_sequence_key"
  ON "assistant_turns"("group_id", "sender_thread_key", "sequence");

CREATE INDEX "assistant_turns_group_id_sender_thread_key_trigger_message_row_id_idx"
  ON "assistant_turns"("group_id", "sender_thread_key", "trigger_message_row_id");

CREATE INDEX "assistant_turns_group_id_sender_thread_key_updated_at_idx"
  ON "assistant_turns"("group_id", "sender_thread_key", "updated_at" DESC);
