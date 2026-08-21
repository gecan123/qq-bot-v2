-- This project explicitly does not preserve local development message data for
-- the QQ + Feishu cutover. Recreate the fact table with the target model.
DROP TABLE IF EXISTS "messages";

CREATE TABLE "messages" (
  "row_id" SERIAL NOT NULL,
  "event_kind" VARCHAR(16) NOT NULL,
  "event_external_id" VARCHAR(255) NOT NULL,
  "platform" VARCHAR(16) NOT NULL,
  "account_id" VARCHAR(191) NOT NULL,
  "conversation_kind" VARCHAR(16) NOT NULL,
  "conversation_external_id" VARCHAR(255) NOT NULL,
  "conversation_name" VARCHAR(255),
  "media_reference_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "message_external_id" VARCHAR(255) NOT NULL,
  "reply_to_external_id" VARCHAR(255),
  "root_external_id" VARCHAR(255),
  "thread_external_id" VARCHAR(255),
  "sender_external_id" VARCHAR(255) NOT NULL,
  "sender_name" VARCHAR(100),
  "sender_conversation_name" VARCHAR(100),
  "content" JSONB NOT NULL,
  "raw_content" JSONB,
  "raw_message" TEXT,
  "search_text" TEXT NOT NULL DEFAULT '',
  "resolved_text" TEXT,
  "sent_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "messages_pkey" PRIMARY KEY ("row_id")
);

CREATE UNIQUE INDEX "messages_platform_account_id_event_external_id_key"
  ON "messages"("platform", "account_id", "event_external_id");
CREATE INDEX "messages_platform_account_id_conversation_kind_conversation_external_id_row_id_idx"
  ON "messages"("platform", "account_id", "conversation_kind", "conversation_external_id", "row_id");
CREATE INDEX "messages_platform_account_id_message_external_id_row_id_idx"
  ON "messages"("platform", "account_id", "message_external_id", "row_id");
CREATE INDEX "messages_platform_account_id_sender_external_id_row_id_idx"
  ON "messages"("platform", "account_id", "sender_external_id", "row_id");
