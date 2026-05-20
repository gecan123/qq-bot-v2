-- Luna 表情包收藏池。collect_sticker 工具写入, compaction 后注入摘要。

CREATE TABLE "sticker_pool" (
    "id" SERIAL NOT NULL,
    "media_id" INTEGER NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "tags" TEXT[] NOT NULL DEFAULT '{}',
    "description" TEXT NOT NULL,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sticker_pool_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sticker_pool_media_id_key" ON "sticker_pool"("media_id");

CREATE INDEX "sticker_pool_use_count_created_at_idx" ON "sticker_pool"("use_count" DESC, "created_at" DESC);
