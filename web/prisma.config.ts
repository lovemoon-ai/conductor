import path from "path";
import { defineConfig } from "prisma/config";
import { loadAppEnv } from "./env-utils";

// Load environment variables from the app env files so Prisma CLI matches the documented setup flow.
loadAppEnv({ cwd: __dirname });

const dbDialect = process.env.DB_DIALECT || "sqlite";

export default defineConfig({
  schema: path.join(__dirname, "prisma", dbDialect === "postgres" ? "schema.postgres.prisma" : "schema.prisma"),
});
