-- CreateTable: Luna 日记 & 做梦。write_journal 工具写入。
CREATE TABLE "journal_entries" (
    "id" SERIAL NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "journal_entries_kind_created_at_idx" ON "journal_entries"("kind", "created_at" DESC);
