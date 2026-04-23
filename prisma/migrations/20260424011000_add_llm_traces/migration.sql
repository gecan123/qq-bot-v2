-- CreateTable
CREATE TABLE "llm_traces" (
    "id" SERIAL NOT NULL,
    "group_id" BIGINT NOT NULL,
    "model" VARCHAR(128),
    "input" JSONB NOT NULL,
    "output" JSONB,
    "duration_ms" INTEGER NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_traces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_traces_group_id_created_at_idx" ON "llm_traces"("group_id", "created_at" DESC);
