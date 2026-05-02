-- CreateTable: bot 私下笔记。IdleThread 写入,reactive @ 路径读取后注入 ephemeralSuffix。
CREATE TABLE "inner_journal" (
    "id" SERIAL NOT NULL,
    "scene_id" VARCHAR(191) NOT NULL,
    "content" TEXT NOT NULL,
    "source_event_ids" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inner_journal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inner_journal_scene_id_created_at_idx" ON "inner_journal"("scene_id", "created_at" DESC);
