CREATE TABLE "reply_records" (
  "id" SERIAL NOT NULL,
  "runtime_key" VARCHAR(191) NOT NULL,
  "group_id" BIGINT NOT NULL,
  "scope_key" VARCHAR(191) NOT NULL,
  "reply_intent_id" VARCHAR(191) NOT NULL,
  "source_kind" VARCHAR(32) NOT NULL,
  "trigger_message_row_id" INTEGER,
  "incorporated_message_row_id" INTEGER,
  "delivery_payload" JSONB NOT NULL,
  "text" TEXT NOT NULL,
  "execution_state" VARCHAR(32) NOT NULL,
  "provider_message_id" BIGINT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "reply_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reply_audits" (
  "id" SERIAL NOT NULL,
  "reply_record_id" INTEGER,
  "runtime_key" VARCHAR(191) NOT NULL,
  "group_id" BIGINT NOT NULL,
  "scope_key" VARCHAR(191) NOT NULL,
  "reply_intent_id" VARCHAR(191) NOT NULL,
  "audit_kind" VARCHAR(32) NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "reply_audits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reply_records_runtime_key_reply_intent_id_key"
  ON "reply_records"("runtime_key", "reply_intent_id");

CREATE INDEX "reply_records_group_id_scope_key_updated_at_idx"
  ON "reply_records"("group_id", "scope_key", "updated_at" DESC);

CREATE INDEX "reply_records_group_id_scope_key_execution_state_updated_at_idx"
  ON "reply_records"("group_id", "scope_key", "execution_state", "updated_at" DESC);

CREATE INDEX "reply_audits_group_id_scope_key_created_at_idx"
  ON "reply_audits"("group_id", "scope_key", "created_at" DESC);

CREATE INDEX "reply_audits_reply_record_id_audit_kind_idx"
  ON "reply_audits"("reply_record_id", "audit_kind");
