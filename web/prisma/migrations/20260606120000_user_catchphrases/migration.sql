-- RFC 0032: per-user catchphrase library used by the chat composer popover.
CREATE TABLE "user_catchphrases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_catchphrases_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "user_catchphrases_user_id_sort_order_idx"
  ON "user_catchphrases"("user_id", "sort_order");
