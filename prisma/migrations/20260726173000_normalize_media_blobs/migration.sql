-- 这是实验性项目的 clean cutover：旧消息、媒体和表情收藏不做回填。
-- 保留 canonical Agent ledger；其中旧 image_ref 会按既有契约解析为 unavailable。
TRUNCATE TABLE "sticker_pool", "messages", "media" RESTART IDENTITY;

CREATE TABLE "media_blobs" (
  "blob_id" SERIAL NOT NULL,
  "data_hash" VARCHAR(64) NOT NULL,
  "data" BYTEA NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "touched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_blobs_pkey" PRIMARY KEY ("blob_id"),
  CONSTRAINT "media_blobs_byte_size_check" CHECK ("byte_size" >= 0)
);

CREATE UNIQUE INDEX "media_blobs_data_hash_key" ON "media_blobs"("data_hash");

DROP INDEX "media_data_hash_key";

ALTER TABLE "media"
  DROP COLUMN "data",
  DROP COLUMN "data_hash",
  ADD COLUMN "blob_id" INTEGER;

CREATE INDEX "media_blob_id_idx" ON "media"("blob_id");

ALTER TABLE "media"
  ADD CONSTRAINT "media_blob_id_fkey"
  FOREIGN KEY ("blob_id") REFERENCES "media_blobs"("blob_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
