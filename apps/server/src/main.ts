import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import { installAuthDiagnostics } from "./oauth/auth-diagnostics.js";

const config = loadServerConfig();
const databasePath = resolve(config.databasePath);
mkdirSync(dirname(databasePath), { recursive: true });

const db = createDatabase(databasePath);
const app = buildApp({
  db,
  config: {
    ...config,
    databasePath,
  },
});

if (process.env.ODR_AUTH_DIAGNOSTICS === "true") installAuthDiagnostics(app);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
  db.close();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await app.listen({
  host: config.listenHost,
  port: config.listenPort,
});
