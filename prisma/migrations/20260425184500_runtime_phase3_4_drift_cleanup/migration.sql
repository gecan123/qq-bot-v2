DROP INDEX IF EXISTS "reply_audits_reply_record_id_audit_kind_idx";

ALTER TABLE IF EXISTS "action_intents" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE IF EXISTS "action_records" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE IF EXISTS "agent_runtime_snapshots" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE IF EXISTS "feed_items" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE IF EXISTS "feed_sources" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE IF EXISTS "memory_items" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE IF EXISTS "opportunities" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE IF EXISTS "read_sessions" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE IF EXISTS "scenes" ALTER COLUMN "updated_at" DROP DEFAULT;

ALTER TABLE IF EXISTS "read_sessions" ADD COLUMN IF NOT EXISTS "content_hash" VARCHAR(64);
CREATE INDEX IF NOT EXISTS "read_sessions_feed_item_id_content_hash_created_at_idx"
  ON "read_sessions"("feed_item_id", "content_hash", "created_at");

ALTER TABLE IF EXISTS "reply_audits" DROP COLUMN IF EXISTS "reply_record_id";
DROP TABLE IF EXISTS "reply_records";
