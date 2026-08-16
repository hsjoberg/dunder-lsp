import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";
import config from "config";

let db: Database | null = null;
const SQLITE_BUSY_TIMEOUT_MS = 10_000;

export default async function getDb(forceReopen: boolean = false) {
  if (db && !forceReopen) {
    return db;
  }

  db = await open({
    filename: config.get<string>("env") === "test" ? ":memory:" : "./database.db",
    driver: sqlite3.Database,
  });
  db.configure("busyTimeout", SQLITE_BUSY_TIMEOUT_MS);
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
  callback: (transactionDb: Database) => Promise<T>,
): Promise<T> {
  const previous = transactionTails.get(db) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  transactionTails.set(db, tail);

  await previous;
  let transactionDb: Database | null = null;
  let isolated = false;
  let transactionStarted = false;
  try {
    // Transactions must not share their connection with ordinary application
    // queries. Otherwise an unrelated db.run() issued while the callback awaits
    // becomes part of this transaction and can be rolled back with it.
    // Anonymous in-memory databases cannot be reopened onto the same database;
    // Dunder uses those only in tests, where work is single-connection.
    transactionDb =
      db.config.filename === ":memory:"
        ? db
        : await open({
            filename: db.config.filename,
            mode: db.config.mode,
            driver: db.config.driver,
          });
    isolated = transactionDb !== db;
    if (isolated) {
      transactionDb.configure("busyTimeout", SQLITE_BUSY_TIMEOUT_MS);
    }

    await transactionDb.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const result = await callback(transactionDb);
    await transactionDb.exec("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted && transactionDb) {
      try {
        await transactionDb.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error("Could not roll back sqlite transaction", rollbackError);
      }
    }
    throw error;
  } finally {
    if (isolated && transactionDb) {
      try {
        await transactionDb.close();
      } catch (closeError) {
        console.error("Could not close sqlite transaction connection", closeError);
      }
    }
    release();
    if (transactionTails.get(db) === tail) {
      transactionTails.delete(db);
    }
  }
}
