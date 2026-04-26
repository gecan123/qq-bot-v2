ALTER TABLE "memory_items"
  ADD COLUMN "memory_type" VARCHAR(64) NOT NULL DEFAULT 'observation',
  ADD COLUMN "source_ref" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "source_proposal_id" VARCHAR(191),
  ADD COLUMN "confidence" DOUBLE PRECISION,
  ADD COLUMN "salience" DOUBLE PRECISION,
  ADD COLUMN "status" VARCHAR(32) NOT NULL DEFAULT 'active',
  ADD COLUMN "decay_policy" JSONB,
  ADD COLUMN "expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "accepted_at" TIMESTAMPTZ(3);

ALTER TABLE "memory_items"
  ALTER COLUMN "memory_type" DROP DEFAULT,
  ALTER COLUMN "source_ref" DROP DEFAULT;

CREATE UNIQUE INDEX "memory_items_source_proposal_id_key" ON "memory_items" ("source_proposal_id");
CREATE INDEX "memory_items_agent_id_memory_type_status_updated_at_idx" ON "memory_items" ("agent_id", "memory_type", "status", "updated_at" DESC);

ALTER TABLE "memory_proposals"
  ADD COLUMN "decay_policy" JSONB,
  ADD COLUMN "expires_at" TIMESTAMPTZ(3);

CREATE TABLE "self_spine_update_proposals" (
  "id" VARCHAR(191) NOT NULL,
  "agent_id" VARCHAR(191) NOT NULL,
  "source_ref" JSONB NOT NULL,
  "patch" JSONB NOT NULL,
  "rationale" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'proposed',
  "idempotency_key" VARCHAR(191) NOT NULL,
  "reviewed_by" VARCHAR(191),
  "reviewed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "self_spine_update_proposals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "self_spine_update_proposals_agent_id_idempotency_key_key" ON "self_spine_update_proposals" ("agent_id", "idempotency_key");
CREATE INDEX "self_spine_update_proposals_agent_id_status_created_at_idx" ON "self_spine_update_proposals" ("agent_id", "status", "created_at");

CREATE TABLE "self_spine_versions" (
  "id" VARCHAR(191) NOT NULL,
  "agent_id" VARCHAR(191) NOT NULL,
  "version" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "diff" JSONB NOT NULL,
  "source_proposal_id" VARCHAR(191),
  "rollback_of_version" INTEGER,
  "status" VARCHAR(32) NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "self_spine_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "self_spine_versions_agent_id_version_key" ON "self_spine_versions" ("agent_id", "version");
CREATE UNIQUE INDEX "self_spine_versions_source_proposal_id_key" ON "self_spine_versions" ("source_proposal_id");
CREATE INDEX "self_spine_versions_agent_id_status_version_idx" ON "self_spine_versions" ("agent_id", "status", "version");
