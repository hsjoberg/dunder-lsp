import { randomUUID } from "crypto";
import { copyFile, mkdir, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

import SQL from "sql-template-strings";
import { sqlFixFilterSortRange } from "../../src/db/utils";

describe("migration 004", () => {
  test("converts existing circuit keys to TEXT and keeps the rows", async () => {
    const dir = join(tmpdir(), `dunder-migrations-${randomUUID()}`);
    const before = join(dir, "before");
    await mkdir(before, { recursive: true });
    const all = (await readdir("migrations")).sort();
    for (const file of all.filter((name) => name < "004")) {
      await copyFile(join("migrations", file), join(before, file));
    }

    const db = await open({ filename: join(dir, "db.sqlite"), driver: sqlite3.Database });
    try {
      await db.migrate({ migrationsPath: before });
      await db.run(
        `INSERT INTO channelRequest (channelId, pubkey, preimage, status, start, expire, expectedAmountSat)
         VALUES ('req', 'pk', 'pre', 'REGISTERED', 0, 600, 1000)`,
      );
      await db.run(
        `INSERT INTO htlcSettlement (channelId, incomingChannelId, htlcId, amountSat, settled, claimed, amountMsat)
         VALUES ('req', 956575116245991424, 7, 1000, 1, 0, '1000000')`,
      );

      await db.migrate({ migrationsPath: "migrations" });

      const row = await db.get(
        `SELECT incomingChannelId, htlcId, typeof(incomingChannelId) AS type, amountMsat
         FROM htlcSettlement`,
      );
      expect(row).toEqual({
        incomingChannelId: "956575116245991424",
        htlcId: "7",
        type: "text",
        amountMsat: "1000000",
      });
      const columns = await db.all<{ name: string }[]>(`PRAGMA table_info(channelOpenAttempt)`);
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["failureKind", "existingClosedChannelPoints"]),
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("admin list filters", () => {
  test("custom filters compare against their value", () => {
    const sql = SQL`SELECT * FROM channelRequest `;
    sqlFixFilterSortRange(sql, undefined, undefined, undefined, {
      custom_days: { field: `DATE(start, "unixepoch")`, comparison: "2026-11-15" },
    });
    expect(sql.values).toEqual(["%2026-11-15%"]);
  });
});
