-- Luna 长期记忆系统 — Minimal Memory Tools
-- 设计文档: ~/.gstack/projects/gecan123-qq-bot-v2/zzz-main-design-20260516-134812.md

CREATE TABLE "memory_entries" (
  "id" SERIAL PRIMARY KEY,
  "target_kind" VARCHAR(16) NOT NULL,
  "target_id" VARCHAR(64) NOT NULL,
  "content" TEXT NOT NULL,
  "source_message_ids" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX "memory_entries_target_kind_target_id_created_at_idx"
  ON "memory_entries" ("target_kind", "target_id", "created_at" DESC);
