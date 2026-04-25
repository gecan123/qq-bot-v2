ALTER TABLE "reply_audits"
  ADD COLUMN IF NOT EXISTS "opportunity_id" VARCHAR(191) NOT NULL DEFAULT '';

UPDATE "reply_audits"
SET "opportunity_id" = "reply_intent_id"
WHERE "opportunity_id" = '';

DELETE FROM "reply_audits" newer
USING "reply_audits" older
WHERE newer."runtime_key" = older."runtime_key"
  AND newer."opportunity_id" = older."opportunity_id"
  AND newer."audit_kind" = older."audit_kind"
  AND newer."id" > older."id";

CREATE UNIQUE INDEX IF NOT EXISTS "reply_audits_runtime_key_opportunity_id_audit_kind_key"
  ON "reply_audits" ("runtime_key", "opportunity_id", "audit_kind");
