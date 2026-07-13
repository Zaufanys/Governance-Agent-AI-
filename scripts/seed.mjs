// Initialize the database and run first-run bootstrap (admin account, ingestion
// API key, sample traces) without starting the HTTP server. Safe to run
// repeatedly — it only creates what is missing.
import { createDb } from "../server/db.mjs";
import { bootstrap } from "../server/bootstrap.mjs";
import { config } from "../server/config.mjs";

const db = createDb(config.dbPath);
const result = bootstrap(db);
db.close();

if (!result.generatedPassword && !result.generatedApiKey && !result.seededTraces) {
  console.log("Nothing to do — database already initialized.");
}
console.log(`Database ready at ${config.dbPath}`);
