import { getUnixTime } from "date-fns";
import { Database } from "sqlite";
import SQL from "sql-template-strings";
import { sqlFixFilterSortRange } from "./utils";

export interface IAdminDB {
  pubkey: string;
  name: string;
}

export async function checkAdminPubkey(db: Database, pubkey: string) {
  return !!(await db.get<{ 1: 1 }>(`SELECT 1 FROM admin WHERE pubkey = $pubkey`, {
    $pubkey: pubkey,
  }));
}

export async function createAdmin(db: Database, pubkey: string, name: string) {
  return db.run(`INSERT INTO admin (pubkey, name) VALUES ($pubkey, $name)`, {
    $pubkey: pubkey,
    $name: name,
  });
}

export async function getAdmins(
  db: Database,
  pubkey?: string,
  filters?: { [key: string]: any | any[] },
  range?: [number, number],
  sort?: [string, string],
) {
  if (pubkey) {
    return db.all<IAdminDB[]>(
      `SELECT
        *
        FROM admin
        WHERE pubkey = $pubkey`,
      {
        $pubkey: pubkey,
      },
    );
  }

  const sql = SQL`
    SELECT
    *
    FROM admin `;
  sqlFixFilterSortRange(sql, filters, range, sort);
  return await db.all<IAdminDB[]>(sql, {});
}

export async function deleteAdmins(db: Database, pubkeys: string[]) {
  const uniquePubkeys = [...new Set(pubkeys)];
  if (uniquePubkeys.length === 0) {
    throw new Error("At least one administrator pubkey is required");
  }

  const placeholders = uniquePubkeys.map(() => "?").join(", ");
  return db.run(`DELETE FROM admin WHERE pubkey IN (${placeholders})`, uniquePubkeys);
}

export async function updateAdmins(db: Database, admin: IAdminDB) {
  return await db.run(
    `UPDATE admin
    SET name = $name
    WHERE pubkey = $pubkey`,
    {
      $name: admin.name,
      $pubkey: admin.pubkey,
    },
  );
}
