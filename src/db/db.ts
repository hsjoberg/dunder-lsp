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

export async function beginTransaction(db: Database) {
  await db.run("BEGIN TRANSACTION");
  return;
}

export async function commit(db: Database) {
  await db.run("COMMIT");
  return;
}

const transactionTails = new WeakMap<Database, Promise<void>>();

/**
 * Serialize application-managed transactions per sqlite connection and take a
 * write reservation up front. BEGIN IMMEDIATE also protects the reservation
 * invariant when more than one Dunder process uses the same sqlite database.
 */
export async function withImmediateTransaction<T>(
  db: Database,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = transactionTails.get(db) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  transactionTails.set(db, tail);

  await previous;
  let transactionStarted = false;
  try {
    await db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const result = await callback();
    await db.exec("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await db.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error("Could not roll back sqlite transaction", rollbackError);
      }
    }
    throw error;
  } finally {
    release();
    if (transactionTails.get(db) === tail) {
      transactionTails.delete(db);
    }
  }
}
