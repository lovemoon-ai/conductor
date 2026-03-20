-- CreateTable
CREATE TABLE "device_auth_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "device_code_hash" TEXT NOT NULL,
    "device_code_salt" TEXT NOT NULL,
    "device_code_prefix" TEXT NOT NULL,
    "user_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by_ip" TEXT,
    "cli_version" TEXT,
    "hostname" TEXT,
    "platform" TEXT,
    "backend_url" TEXT,
    "expires_at" DATETIME NOT NULL,
    "approved_at" DATETIME,
    "denied_at" DATETIME,
    "consumed_at" DATETIME,
    "approved_by_user_id" TEXT,
    "issued_user_token_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "device_auth_sessions_user_code_key" ON "device_auth_sessions"("user_code");

-- CreateIndex
CREATE INDEX "device_auth_sessions_device_code_prefix_status_idx" ON "device_auth_sessions"("device_code_prefix", "status");

-- CreateIndex
CREATE INDEX "device_auth_sessions_expires_at_status_idx" ON "device_auth_sessions"("expires_at", "status");

-- CreateIndex
CREATE INDEX "device_auth_sessions_approved_by_user_id_idx" ON "device_auth_sessions"("approved_by_user_id");
