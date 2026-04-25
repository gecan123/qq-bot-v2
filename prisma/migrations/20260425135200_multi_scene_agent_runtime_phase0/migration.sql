-- Destructive Phase 0: agent:main is the only root runtime; qq_group is a Scene.
DROP TABLE IF EXISTS "root_runtime_snapshots" CASCADE;
DROP TABLE IF EXISTS "reply_records" CASCADE;
ALTER TABLE IF EXISTS "reply_audits" DROP COLUMN IF EXISTS "reply_record_id";

CREATE TABLE "agent_runtime_snapshots" (
  "id" SERIAL PRIMARY KEY,
  "agent_id" VARCHAR(191) NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "context_snapshot" JSONB NOT NULL,
  "session_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "agent_runtime_snapshots_agent_id_key" ON "agent_runtime_snapshots" ("agent_id");

CREATE TABLE "scenes" (
  "id" VARCHAR(191) PRIMARY KEY,
  "agent_id" VARCHAR(191) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "external_id" VARCHAR(191) NOT NULL,
  "display_name" VARCHAR(255),
  "policy" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "scenes_agent_id_kind_external_id_key" ON "scenes" ("agent_id", "kind", "external_id");
CREATE INDEX "scenes_agent_id_updated_at_idx" ON "scenes" ("agent_id", "updated_at" DESC);

CREATE TABLE "runtime_events" (
  "id" VARCHAR(191) PRIMARY KEY,
  "scene_id" VARCHAR(191) NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "idempotency_key" VARCHAR(191) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "runtime_events_scene_id_idempotency_key_key" ON "runtime_events" ("scene_id", "idempotency_key");
CREATE INDEX "runtime_events_scene_id_occurred_at_idx" ON "runtime_events" ("scene_id", "occurred_at" DESC);

CREATE TABLE "opportunities" (
  "id" VARCHAR(191) PRIMARY KEY,
  "scene_id" VARCHAR(191) NOT NULL,
  "runtime_event_id" VARCHAR(191),
  "queue_kind" VARCHAR(32) NOT NULL,
  "opportunity_type" VARCHAR(64) NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "deadline_at" TIMESTAMPTZ(3),
  "payload" JSONB NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
  "idempotency_key" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "opportunities_scene_id_idempotency_key_key" ON "opportunities" ("scene_id", "idempotency_key");
CREATE INDEX "opportunities_scene_id_status_priority_created_at_idx" ON "opportunities" ("scene_id", "status", "priority" DESC, "created_at");

CREATE TABLE "action_intents" (
  "id" VARCHAR(191) PRIMARY KEY,
  "opportunity_id" VARCHAR(191) NOT NULL,
  "action_type" VARCHAR(64) NOT NULL,
  "target_scene_id" VARCHAR(191) NOT NULL,
  "payload" JSONB NOT NULL,
  "dry_run" BOOLEAN NOT NULL DEFAULT false,
  "risk_level" VARCHAR(32) NOT NULL DEFAULT 'low',
  "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
  "idempotency_key" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "action_intents_opportunity_id_idempotency_key_key" ON "action_intents" ("opportunity_id", "idempotency_key");
CREATE INDEX "action_intents_target_scene_id_status_created_at_idx" ON "action_intents" ("target_scene_id", "status", "created_at");

CREATE TABLE "action_records" (
  "id" VARCHAR(191) PRIMARY KEY,
  "action_intent_id" VARCHAR(191) NOT NULL,
  "action_type" VARCHAR(64) NOT NULL,
  "target_scene_id" VARCHAR(191) NOT NULL,
  "delivery_state" VARCHAR(32) NOT NULL,
  "idempotency_key" VARCHAR(191) NOT NULL,
  "result_payload" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "action_records_idempotency_key_key" ON "action_records" ("idempotency_key");
CREATE INDEX "action_records_target_scene_id_delivery_state_created_at_idx" ON "action_records" ("target_scene_id", "delivery_state", "created_at");

CREATE TABLE "memory_items" (
  "id" VARCHAR(191) PRIMARY KEY,
  "agent_id" VARCHAR(191) NOT NULL,
  "scope" VARCHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'dormant',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "memory_items_agent_id_scope_updated_at_idx" ON "memory_items" ("agent_id", "scope", "updated_at" DESC);
