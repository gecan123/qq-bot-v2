CREATE INDEX "memory_proposals_source_ref_gin_idx"
  ON "memory_proposals" USING GIN ("source_ref" jsonb_path_ops);

CREATE INDEX "self_spine_update_proposals_status_created_at_idx"
  ON "self_spine_update_proposals" ("status", "created_at");
