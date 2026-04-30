-- AlterTable
ALTER TABLE "projects" ADD COLUMN "hidden_at" DATETIME;

-- CreateIndex
CREATE INDEX "projects_user_id_hidden_at_idx" ON "projects" ("user_id", "hidden_at");
