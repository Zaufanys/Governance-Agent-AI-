// Central configuration. Values come from environment variables (optionally
// loaded from a .env file at the project root) with sensible defaults so the
// app runs with zero configuration out of the box.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env if present (Node >= 20.6). Never fatal if the file is missing.
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  /* no .env file — fall back to real environment / defaults */
}

const bool = (v, dflt) => (v == null ? dflt : /^(1|true|yes|on)$/i.test(String(v)));

export const config = {
  root,
  port: Number(process.env.PORT) || 4175,
  host: process.env.HOST || "0.0.0.0",

  // Where the SQLite database file lives.
  dbPath: process.env.DB_PATH || path.join(root, "data", "governance.db"),

  // Static assets to serve (the built dashboard).
  publicDir: path.join(root, "public"),

  // Session lifetime for the reviewer dashboard.
  sessionTtlMs: Number(process.env.SESSION_TTL_MS) || 1000 * 60 * 60 * 12, // 12h

  // First-run bootstrap. If a password / key is not supplied, one is generated
  // and printed to the console exactly once (see server/bootstrap.mjs).
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "", // "" => generate on first run
  ingestApiKey: process.env.INGEST_API_KEY || "", // "" => generate on first run

  // Seed a handful of example traces on first run so the dashboard isn't empty.
  seedSamples: bool(process.env.SEED_SAMPLES, true),
};
