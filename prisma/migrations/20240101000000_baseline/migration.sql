-- Baseline migration: documents the schema state created via db:push
-- before migration tracking began.

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "group_id" BIGINT NOT NULL,
    "group_name" VARCHAR(255),
    "media_reference_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "message_id" BIGINT NOT NULL,
    "sender_id" BIGINT NOT NULL,
    "sender_nickname" VARCHAR(100),
    "sender_group_nickname" VARCHAR(100),
    "content" JSONB NOT NULL,
    "raw_content" JSONB,
    "raw_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "media_id" SERIAL NOT NULL,
    "data" BYTEA NOT NULL,
    "data_hash" VARCHAR(64),
    "media_type" TEXT,
    "content_type" TEXT,
    "file_name" TEXT,
    "file_size" INTEGER,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("media_id")
);

-- CreateIndex
CREATE INDEX "messages_group_id_created_at_idx" ON "messages"("group_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "messages_group_id_message_id_key" ON "messages"("group_id", "message_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_data_hash_key" ON "media"("data_hash");
