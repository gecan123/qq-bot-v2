-- CreateTable
CREATE TABLE "scene_agent_contexts" (
    "scene_id" VARCHAR(191) NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scene_agent_contexts_pkey" PRIMARY KEY ("scene_id")
);
