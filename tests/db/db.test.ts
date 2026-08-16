import { randomUUID } from "crypto";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";

import { withImmediateTransaction } from "../../src/db/db";

describe("withImmediateTransaction", () => {
  let db: Database;
  let filename: string;

  beforeEach(async () => {
    filename = join(tmpdir(), `dunder-transaction-${randomUUID()}.db`);
    db = await open({ filename, driver: sqlite3.Database });
    db.configure("busyTimeout", 2_000);
    await db.exec("CREATE TABLE probe (value TEXT NOT NULL)");
  });

  afterEach(async () => {
    await db.close();
    await Promise.all(
      [filename, `${filename}-journal`, `${filename}-shm`, `${filename}-wal`].map((path) =>
        rm(path, { force: true }),
      ),
    );
  });

  test("does not roll back an unrelated write on the application connection", async () => {
    let unrelatedWrite: ReturnType<Database["run"]> | undefined;

    const transaction = withImmediateTransaction(db, async (transactionDb) => {
      expect(transactionDb).not.toBe(db);
      await transactionDb.run("INSERT INTO probe VALUES ('managed')");

      // This write must wait on its own connection. With the old shared
      // connection it resolved inside this transaction and was then silently
      // removed by the rollback below.
      unrelatedWrite = db.run("INSERT INTO probe VALUES ('unrelated')");
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("roll back managed work");
    });

    await expect(transaction).rejects.toThrow("roll back managed work");
    await expect(unrelatedWrite).resolves.toBeDefined();
    await expect(db.all("SELECT value FROM probe ORDER BY value")).resolves.toEqual([
      { value: "unrelated" },
    ]);
  });
});
