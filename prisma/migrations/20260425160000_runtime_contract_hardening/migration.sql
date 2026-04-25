ALTER TABLE "action_intents" ADD COLUMN "decision_id" VARCHAR(191);
ALTER TABLE "action_intents" ALTER COLUMN "risk_level" SET DEFAULT 'L1';
ALTER TABLE "action_intents" ALTER COLUMN "status" SET DEFAULT 'proposed';

UPDATE "action_intents"
SET "risk_level" = CASE
    WHEN "risk_level" = 'low' THEN 'L1'
    WHEN "risk_level" = 'medium' THEN 'L3'
    WHEN "risk_level" = 'high' THEN 'L4'
    ELSE "risk_level"
END;

UPDATE "action_intents"
SET "status" = CASE
    WHEN "status" = 'pending' THEN 'proposed'
    WHEN "status" = 'completed' THEN 'succeeded'
    WHEN "status" = 'suppressed' THEN 'skipped'
    WHEN "status" = 'dry_run' THEN 'skipped'
    ELSE "status"
END;

CREATE INDEX "action_intents_decision_id_idx" ON "action_intents" ("decision_id");

CREATE TABLE "decisions" (
    "id" VARCHAR(191) NOT NULL,
    "opportunity_id" VARCHAR(191) NOT NULL,
    "idempotency_key" VARCHAR(191) NOT NULL,
    "policy_version" VARCHAR(64) NOT NULL,
    "verdict" VARCHAR(32) NOT NULL,
    "risk_level" VARCHAR(32) NOT NULL,
    "reason" TEXT NOT NULL,
    "barrier_input" JSONB NOT NULL,
    "barrier_output" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "decisions_opportunity_id_idempotency_key_key" ON "decisions" ("opportunity_id", "idempotency_key");
CREATE INDEX "decisions_opportunity_id_created_at_idx" ON "decisions" ("opportunity_id", "created_at");

CREATE TABLE "memory_proposals" (
    "id" VARCHAR(191) NOT NULL,
    "agent_id" VARCHAR(191) NOT NULL,
    "source_ref" JSONB NOT NULL,
    "proposal_type" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "salience" DOUBLE PRECISION,
    "status" VARCHAR(32) NOT NULL DEFAULT 'proposed',
    "idempotency_key" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_proposals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_proposals_agent_id_idempotency_key_key" ON "memory_proposals" ("agent_id", "idempotency_key");
CREATE INDEX "memory_proposals_agent_id_status_created_at_idx" ON "memory_proposals" ("agent_id", "status", "created_at");
