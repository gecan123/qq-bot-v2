ALTER TABLE "messages" ADD COLUMN "scene_kind" VARCHAR(32) NOT NULL DEFAULT 'qq_group';
ALTER TABLE "messages" ADD COLUMN "scene_external_id" VARCHAR(191);

UPDATE "messages"
SET "scene_external_id" = "group_id"::text
WHERE "scene_external_id" IS NULL;

ALTER TABLE "messages" ALTER COLUMN "scene_external_id" SET NOT NULL;
ALTER TABLE "messages" ALTER COLUMN "scene_external_id" SET DEFAULT '';

DROP INDEX IF EXISTS "messages_group_id_message_id_key";

CREATE UNIQUE INDEX "messages_scene_kind_scene_external_id_message_id_key"
  ON "messages"("scene_kind", "scene_external_id", "message_id");
CREATE INDEX "messages_scene_kind_scene_external_id_created_at_idx"
  ON "messages"("scene_kind", "scene_external_id", "created_at" DESC);

CREATE TABLE "feed_sources" (
  "id" VARCHAR(191) NOT NULL,
  "scene_id" VARCHAR(191) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "external_id" VARCHAR(191) NOT NULL,
  "display_name" VARCHAR(255),
  "config" JSONB,
  "status" VARCHAR(32) NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "feed_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "feed_sources_kind_external_id_key" ON "feed_sources"("kind", "external_id");
CREATE INDEX "feed_sources_scene_id_status_idx" ON "feed_sources"("scene_id", "status");

CREATE TABLE "feed_items" (
  "id" VARCHAR(191) NOT NULL,
  "feed_source_id" VARCHAR(191) NOT NULL,
  "external_id" VARCHAR(191) NOT NULL,
  "url" TEXT,
  "title" TEXT NOT NULL,
  "author" VARCHAR(255),
  "raw_content" TEXT,
  "content_hash" VARCHAR(64),
  "published_at" TIMESTAMPTZ(3),
  "seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "feed_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "feed_items_feed_source_id_external_id_key" ON "feed_items"("feed_source_id", "external_id");
CREATE INDEX "feed_items_feed_source_id_seen_at_idx" ON "feed_items"("feed_source_id", "seen_at" DESC);

CREATE TABLE "read_sessions" (
  "id" VARCHAR(191) NOT NULL,
  "feed_item_id" VARCHAR(191) NOT NULL,
  "content_hash" VARCHAR(64),
  "opportunity_id" VARCHAR(191) NOT NULL,
  "action_record_id" VARCHAR(191),
  "selection_reason" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'completed',
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "read_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "read_sessions_feed_item_id_created_at_idx" ON "read_sessions"("feed_item_id", "created_at");
CREATE INDEX "read_sessions_feed_item_id_content_hash_created_at_idx" ON "read_sessions"("feed_item_id", "content_hash", "created_at");
CREATE INDEX "read_sessions_opportunity_id_idx" ON "read_sessions"("opportunity_id");

CREATE TABLE "source_summaries" (
  "id" VARCHAR(191) NOT NULL,
  "read_session_id" VARCHAR(191) NOT NULL,
  "summary" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "source_summaries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "source_summaries_read_session_id_idx" ON "source_summaries"("read_session_id");

CREATE TABLE "thought_artifacts" (
  "id" VARCHAR(191) NOT NULL,
  "read_session_id" VARCHAR(191) NOT NULL,
  "thought" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "thought_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "thought_artifacts_read_session_id_idx" ON "thought_artifacts"("read_session_id");

CREATE TABLE "rationale_artifacts" (
  "id" VARCHAR(191) NOT NULL,
  "read_session_id" VARCHAR(191) NOT NULL,
  "rationale" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rationale_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rationale_artifacts_read_session_id_idx" ON "rationale_artifacts"("read_session_id");
