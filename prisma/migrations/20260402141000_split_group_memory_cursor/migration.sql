-- CreateTable
CREATE TABLE "group_memory_cursor" (
    "id" SERIAL NOT NULL,
    "group_id" BIGINT NOT NULL,
    "last_processed_external_message_id" BIGINT NOT NULL,
    "last_processed_message_row_id" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_memory_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_memory_cursor_group_id_key" ON "group_memory_cursor"("group_id");

-- Backfill
INSERT INTO "group_memory_cursor" (
    "group_id",
    "last_processed_external_message_id",
    "last_processed_message_row_id",
    "updated_at"
)
SELECT
    "group_id",
    "last_message_id",
    "last_message_db_id",
    "updated_at"
FROM "group_memory"
WHERE "last_message_db_id" IS NOT NULL;

-- AlterTable
ALTER TABLE "group_memory"
DROP COLUMN "last_message_id",
DROP COLUMN "last_message_db_id";
