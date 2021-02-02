import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";
import config from "config";

let db: Database | null = null;

export default async function getDb(forceReopen: boolean = false) {
  if (db && !forceReopen) {
    return db;
  }

  db = await open({
    filename: config.get<string>("env") === "test" ? ":memory:" : "./database.db",
    driver: sqlite3.Database,
  });
  await db.migrate();

  if (config.get("env") === "development") {
    sqlite3.verbose();
  }

  return db;
}
