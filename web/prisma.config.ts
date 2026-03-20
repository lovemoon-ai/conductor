import path from "path";
import { defineConfig } from "prisma/config";
import { config } from "dotenv";

// Load environment variables from .env file
config({ path: path.join(__dirname, ".env") });

const dbDialect = process.env.DB_DIALECT || "sqlite";

export default defineConfig({
  schema: path.join(__dirname, "prisma", dbDialect === "postgres" ? "schema.postgres.prisma" : "schema.prisma"),
});
