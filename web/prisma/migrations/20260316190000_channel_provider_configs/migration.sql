-- CreateTable
CREATE TABLE "channel_provider_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "app_secret" TEXT NOT NULL,
    "verification_token" TEXT NOT NULL,
    "encrypt_key" TEXT,
    "metadata" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "channel_provider_configs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_provider_configs_user_id_provider_key" ON "channel_provider_configs"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "channel_provider_configs_provider_verification_token_key" ON "channel_provider_configs"("provider", "verification_token");

-- CreateIndex
CREATE INDEX "channel_provider_configs_provider_app_id_idx" ON "channel_provider_configs"("provider", "app_id");
