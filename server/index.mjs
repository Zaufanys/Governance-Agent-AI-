// HTTP server: serves the dashboard static files and the /api/* REST API.
// `startServer()` is exported so the test suite can boot an isolated instance
// on an ephemeral port with its own database.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.mjs";
import { bootstrap } from "./bootstrap.mjs";
import { handleApi } from "./api.mjs";
import { config } from "./config.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(res, pathname, publicDir) {
  const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const fp = path.join(publicDir, rel);
  if (fp !== publicDir && !fp.startsWith(publicDir + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(fp)] || "text/plain" });
    res.end(data);
  });
}

export function createHttpServer(ctx) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Bad request");
    }
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url, ctx);
      if (!handled && !res.headersSent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"Not found"}');
      }
      return;
    }
    serveStatic(res, url.pathname, ctx.config.publicDir);
  });
}

// Boots a full instance. Overrides let tests isolate DB/port and skip seeding.
export function startServer(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const db = createDb(cfg.dbPath);
  if (!overrides.skipBootstrap) {
    bootstrap(db, { log: overrides.log, seedSamples: overrides.seedSamples });
  }
  const server = createHttpServer({ db, config: cfg });
  return new Promise((resolve) => {
    server.listen(cfg.port, cfg.host, () => {
      resolve({
        server,
        db,
        port: server.address().port,
        config: cfg,
        close: () =>
          new Promise((r) => server.close(() => { db.close(); r(); })),
      });
    });
  });
}

// Run directly: `node server/index.mjs`
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  startServer().then(({ port }) => {
    console.log("AI Agent Governance Dashboard");
    console.log(`  dashboard : http://localhost:${port}/`);
    console.log(`  login     : http://localhost:${port}/login.html`);
    console.log(`  API       : http://localhost:${port}/api/`);
    console.log("");
  });
}
