-- AlterTable
ALTER TABLE "messages"
ADD COLUMN "sent_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "messages"
ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3)
USING "created_at" AT TIME ZONE 'Asia/Shanghai';

-- AlterTable
ALTER TABLE "media"
ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3)
USING "created_at" AT TIME ZONE 'Asia/Shanghai';

-- AlterTable
ALTER TABLE "group_memory"
ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(3)
USING "updated_at" AT TIME ZONE 'Asia/Shanghai';

-- AlterTable
ALTER TABLE "user_memory"
ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(3)
USING "updated_at" AT TIME ZONE 'Asia/Shanghai';
