-- RFC 0035: Daemon Sharing.
-- A `DaemonShare` row is one grant of "user A's daemon may be used by user B".
-- The guest daemon process runs on A's machine but authenticates as B, so B's
-- tasks stay ordinary rows under B's own projects and every existing ownership
-- check keeps working unchanged.
--
-- `guest_host` is the daemon name the grantee sees. It is unique per grantee,
-- NOT globally: the realtime hub keys agent connections by (userId, host), so
-- two different accounts may legitimately hold the same host name.
--
-- `token_id` points at the scoped `user_tokens` row minted for the grantee.
-- No foreign key: revoking a token must not cascade away the share's audit row.
CREATE TABLE "daemon_shares" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_user_id" TEXT NOT NULL,
    "owner_daemon_host" TEXT NOT NULL,
    "grantee_user_id" TEXT,
    "guest_host" TEXT,
    "invite_token" TEXT NOT NULL,
    "workspace_root" TEXT,
    "token_id" TEXT,
    -- Plaintext of the scoped token. Only ever returned to the OWNER via
    -- GET /api/daemon-shares/mine, over the owner's own authenticated channel --
    -- never through the grantee's browser. Nulled on revoke.
    "agent_token" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "accepted_at" DATETIME,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "daemon_shares_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "daemon_shares_grantee_user_id_fkey" FOREIGN KEY ("grantee_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "daemon_shares_invite_token_key" ON "daemon_shares"("invite_token");
CREATE UNIQUE INDEX "daemon_shares_grantee_user_id_guest_host_key" ON "daemon_shares"("grantee_user_id", "guest_host");
CREATE INDEX "daemon_shares_owner_user_id_owner_daemon_host_idx" ON "daemon_shares"("owner_user_id", "owner_daemon_host");
CREATE INDEX "daemon_shares_grantee_user_id_status_idx" ON "daemon_shares"("grantee_user_id", "status");
