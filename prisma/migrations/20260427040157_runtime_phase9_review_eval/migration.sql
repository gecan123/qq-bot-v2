CREATE TABLE "read_session_reviews" (
  "id" VARCHAR(191) NOT NULL,
  "read_session_id" VARCHAR(191) NOT NULL,
  "reviewer" VARCHAR(191) NOT NULL DEFAULT 'admin',
  "score" INTEGER,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "read_session_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "read_session_reviews_read_session_id_reviewer_key" ON "read_session_reviews"("read_session_id", "reviewer");
CREATE INDEX "read_session_reviews_read_session_id_updated_at_idx" ON "read_session_reviews"("read_session_id", "updated_at" DESC);
