CREATE TABLE "root_runtime_snapshots" (
  "id" SERIAL NOT NULL,
  "runtime_key" VARCHAR(191) NOT NULL,
  "group_id" BIGINT NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "context_snapshot" JSONB NOT NULL,
  "session_snapshot" JSONB NOT NULL,
  "last_observed_message_row_id" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "root_runtime_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "root_runtime_snapshots_runtime_key_key"
  ON "root_runtime_snapshots"("runtime_key");

CREATE INDEX "root_runtime_snapshots_group_id_updated_at_idx"
  ON "root_runtime_snapshots"("group_id", "updated_at" DESC);
