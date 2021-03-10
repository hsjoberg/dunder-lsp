import { Database } from "sqlite";
import SQL from "sql-template-strings";

import { IChannelRequestDB, IHtlcSettlementDB } from "./ondemand-channel";
import { getUnixTime } from "date-fns";
import { CustomFilter, sqlFixFilterSortRange } from "./utils";

export async function getChannelRequestTotal(db: Database) {
  const result = await db.get<{ total: number }>(`SELECT COUNT(*) as total FROM channelRequest`);
  return result!.total;
}

export function getChannelRequests(
  db: Database,
  channelId?: string,
  filters?: { [key: string]: any | any[] },
  range?: [number, number],
  sort?: [string, string],
) {
  if (channelId) {
    return db.all<IChannelRequestDB[]>(
      `SELECT
      *,
      CASE WHEN status != "DONE" AND $currentUnixTimestamp > (start + expire) THEN 1 ELSE 0 END AS expired
      FROM channelRequest
      WHERE channelId = $channelId`,
      {
        $currentUnixTimestamp: getUnixTime(new Date()),
        $channelId: channelId,
      },
    );
  }

  const sql = SQL`
    SELECT
    *,
    CASE WHEN status != "DONE" AND
    ${getUnixTime(new Date())} > (start + expire) THEN 1 ELSE 0 END AS expired
    FROM channelRequest `;

  let customFilters: CustomFilter = {};
  if (filters && filters.custom_days) {
    const customDays = filters.custom_days;
    delete filters.custom_days;
    customFilters = {
      [`custom_days`]: {
        field: `DATE(start, "unixepoch")`,
        comparison: customDays,
      },
    };
  }
  sqlFixFilterSortRange(sql, filters, range, sort, customFilters);
  return db.all<IChannelRequestDB[]>(sql, { $currentUnixTimestamp: getUnixTime(new Date()) });
}

export async function getHtlcSettlementsTotal(db: Database) {
  const result = await db.get<{ total: number }>(`SELECT COUNT(*) as total FROM htlcSettlement`);
  return result!.total;
}

export async function getHtlcSettlements(
  db: Database,
  htlcId?: number,
  filters?: { [key: string]: any },
  range?: [number, number],
  sort?: [string, string],
) {
  if (htlcId) {
    return db.all<IHtlcSettlementDB[]>(
      `SELECT *
      FROM htlcSettlement
      WHERE htlcId = $htlcId`,
      {
        $htlcId: htlcId,
      },
    );
  }

  const sql = SQL`
    SELECT * FROM htlcSettlement
    JOIN channelRequest ON htlcSettlement.channelId = channelRequest.channelId `;
  sqlFixFilterSortRange(sql, filters, range, sort);
  return db.all<IHtlcSettlementDB[]>(sql, {});
}
