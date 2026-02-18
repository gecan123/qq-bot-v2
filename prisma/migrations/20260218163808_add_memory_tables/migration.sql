-- CreateTable
CREATE TABLE "group_memory" (
    "id" SERIAL NOT NULL,
    "group_id" BIGINT NOT NULL,
    "group_name" VARCHAR(255),
    "summary" TEXT NOT NULL,
    "last_message_id" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_memory" (
    "id" SERIAL NOT NULL,
    "group_id" BIGINT NOT NULL,
    "group_name" VARCHAR(255),
    "sender_id" BIGINT NOT NULL,
    "sender_nickname" VARCHAR(100),
    "sender_group_nickname" VARCHAR(100),
    "profile" TEXT NOT NULL,
    "examples" TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_memory_group_id_key" ON "group_memory"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_memory_group_id_sender_id_key" ON "user_memory"("group_id", "sender_id");
