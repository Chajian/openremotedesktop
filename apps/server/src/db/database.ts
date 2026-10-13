import BetterSqlite3 from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export function createDatabase(path: string): BetterSqlite3.Database {
  const db = new BetterSqlite3(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  runMigrations(db);
  return db;
}

export { runMigrations } from "./migrations.js";
