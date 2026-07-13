// First-run bootstrap: make sure the app is usable the moment it starts.
// Creates an admin account and an ingestion API key if none exist (printing any
// generated secrets exactly once) and seeds example traces into an empty DB.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, newId, newApiKey } from "./auth.mjs";
import { ingestTrace } from "./traces.mjs";
import { config } from "./config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export function bootstrap(db, opts = {}) {
  const log = opts.log ?? console.log;
  const seedSamples = opts.seedSamples ?? config.seedSamples;
  const result = { generatedPassword: null, generatedApiKey: null, seededTraces: 0 };

  // 1) Admin account.
  if (db.countUsers() === 0) {
    let password = config.adminPassword;
    if (!password) {
      password = newApiKey().slice(4, 20); // random 16-char secret
      result.generatedPassword = password;
    }
    db.createUser({
      id: newId(),
      username: config.adminUsername,
      passwordHash: hashPassword(password),
      role: "admin",
      createdAt: new Date().toISOString(),
    });
    if (result.generatedPassword) {
      log("");
      log("  ┌─ First-run admin account created");
      log(`  │   username: ${config.adminUsername}`);
      log(`  │   password: ${password}`);
      log("  └─ Set ADMIN_PASSWORD in the environment to pick your own.");
      log("");
    }
  }

  // 2) Ingestion API key.
  if (db.countApiKeys() === 0) {
    const key = config.ingestApiKey || newApiKey();
    if (!config.ingestApiKey) result.generatedApiKey = key;
    db.createApiKey({ key, label: "default", createdAt: new Date().toISOString() });
    if (result.generatedApiKey) {
      log("  ┌─ Ingestion API key created");
      log(`  │   ${key}`);
      log("  └─ Agents send traces with header:  Authorization: Bearer <key>");
      log("");
    }
  }

  // 3) Seed example traces into an empty database.
  if (seedSamples && db.countTraces() === 0) {
    const file = path.join(here, "seed-data.json");
    if (fs.existsSync(file)) {
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const row of rows) {
        try {
          ingestTrace(db, row);
          result.seededTraces++;
        } catch {
          /* skip malformed sample */
        }
      }
      if (result.seededTraces) {
        log(`  Seeded ${result.seededTraces} example traces (set SEED_SAMPLES=0 to disable).`);
      }
    }
  }

  return result;
}
