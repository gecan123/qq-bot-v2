ALTER TABLE "llm_traces"
  ADD COLUMN "frame_id" VARCHAR(191),
  ADD COLUMN "scene_id" VARCHAR(191),
  ADD COLUMN "opportunity_id" VARCHAR(191),
  ADD COLUMN "loop_index" INTEGER,
  ADD COLUMN "input_hash" VARCHAR(64),
  ADD COLUMN "prefix_hash" VARCHAR(64),
  ADD COLUMN "tail_hash" VARCHAR(64),
  ADD COLUMN "context_frame" JSONB,
  ADD COLUMN "input_tokens" INTEGER,
  ADD COLUMN "cached_tokens" INTEGER,
  ADD COLUMN "output_tokens" INTEGER,
  ADD COLUMN "token_usage_state" VARCHAR(32);

CREATE INDEX "llm_traces_frame_id_loop_index_idx" ON "llm_traces"("frame_id", "loop_index");
CREATE INDEX "llm_traces_scene_id_opportunity_id_idx" ON "llm_traces"("scene_id", "opportunity_id");
