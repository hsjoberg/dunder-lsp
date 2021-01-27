import sqlite3 from "sqlite3";
import { open } from "sqlite";
import config from "config";

const db = await open({
  filename: "./database.db",
  driver: sqlite3.Database,
});
await db.migrate();

if (config.get("env") === "development") {
  sqlite3.verbose();
}

export default db;
