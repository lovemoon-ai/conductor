-- CreateTable
CREATE TABLE "sso_authorization_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "code_salt" TEXT NOT NULL,
    "code_prefix" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "consumed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "sso_authorization_codes_client_id_code_prefix_idx" ON "sso_authorization_codes"("client_id", "code_prefix");

-- CreateIndex
CREATE INDEX "sso_authorization_codes_user_id_created_at_idx" ON "sso_authorization_codes"("user_id", "created_at");
