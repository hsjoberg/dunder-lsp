import Long from "long";
import { Database } from "sqlite";

import { MSAT } from "../utils/constants";
import { withImmediateTransaction } from "./db";
import { IChannelRequestDB, IHtlcSettlementDB } from "./ondemand-channel";

export type ChannelOpenAttemptSource = "AUTOMATIC" | "CLAIM" | "AUTO_HEAL";
export type ChannelOpenAttemptStatus = "OPENING" | "UNKNOWN" | "OPENED" | "CANCELLED";

export interface IChannelOpenAttemptDB {
  attemptId: string;
  pubkey: string;
  source: ChannelOpenAttemptSource;
  requestedChannelId: string | null;
  status: ChannelOpenAttemptStatus;
  grossAmountSat: number;
  feeSat: number;
  pushAmountSat: number;
  existingChannelPoints: string;
  channelPoint: string | null;
  error: string | null;
  spendUnconfirmed: number;
  zeroConf: number;
  taprootChannel: number;
  rpcDispatched: number;
  dispatchCount: number;
  createdAt: number;
  updatedAt: number;
}

type ReservationOptions = {
  attemptId: string;
  pubkey: string;
  source: ChannelOpenAttemptSource;
  requestedChannelId?: string;
  requiredAmountSat?: number;
  maximumAmountSat: number;
  feeSat: number;
  existingChannelPoints: string[];
  spendUnconfirmed: boolean;
  zeroConf: boolean;
  taprootChannel: boolean;
};

export type ChannelOpenReservationResult =
  | { status: "RESERVED"; attempt: IChannelOpenAttemptDB }
  | { status: "ACTIVE_ATTEMPT"; attempt: IChannelOpenAttemptDB }
  | { status: "NO_SETTLEMENTS" }
  | { status: "AMOUNT_MISMATCH"; amountSat: number }
  | { status: "FEE_EXCEEDS_AMOUNT"; amountSat: number };

export function getActiveChannelOpenAttempt(db: Database, pubkey: string) {
  return db.get<IChannelOpenAttemptDB>(
    `SELECT *
     FROM channelOpenAttempt
     WHERE pubkey = $pubkey AND status IN ('OPENING', 'UNKNOWN')`,
    { $pubkey: pubkey },
  );
}

export function getActiveChannelOpenAttempts(db: Database) {
  return db.all<IChannelOpenAttemptDB[]>(
    `SELECT *
     FROM channelOpenAttempt
     WHERE status IN ('OPENING', 'UNKNOWN')
     ORDER BY createdAt, attemptId`,
  );
}

export function getChannelOpenAttempts(db: Database, limit = 100) {
  return db.all<IChannelOpenAttemptDB[]>(
    `SELECT *
     FROM channelOpenAttempt
     ORDER BY createdAt DESC, attemptId DESC
     LIMIT $limit`,
    { $limit: limit },
  );
}

/**
 * The rows returned here are the durable automatic-opening queue. They are
 * requests whose complete payment is settled but has not yet been paid out.
 * Keeping the queue derivable from settlement state means it survives a
 * process restart without another in-memory job table.
 */
export function getRecoverableAutomaticChannelRequests(db: Database) {
  return db.all<IChannelRequestDB[]>(
    `SELECT channelRequest.*
     FROM channelRequest
     JOIN htlcSettlement
       ON htlcSettlement.channelId = channelRequest.channelId
     WHERE channelRequest.status = 'REGISTERED'
       AND channelRequest.automaticOpenQueued = 1
     GROUP BY channelRequest.channelId
     HAVING SUM(
       CASE
         WHEN htlcSettlement.settled = 1 AND htlcSettlement.claimed = 0
           THEN CAST(
             COALESCE(
               htlcSettlement.amountMsat,
               CAST(htlcSettlement.amountSat * 1000 AS TEXT)
             ) AS INTEGER
           )
         ELSE 0
       END
     ) = channelRequest.expectedAmountSat * 1000
       AND SUM(CASE WHEN htlcSettlement.settled = 0 THEN 1 ELSE 0 END) = 0
       AND SUM(CASE WHEN htlcSettlement.claimed = 1 THEN 1 ELSE 0 END) = 0
     ORDER BY channelRequest.start, channelRequest.channelId`,
  );
}

export function getChannelOpenAttempt(db: Database, attemptId: string) {
  return db.get<IChannelOpenAttemptDB>(
    `SELECT * FROM channelOpenAttempt WHERE attemptId = $attemptId`,
    { $attemptId: attemptId },
  );
}

export function getChannelOpenAttemptSettlements(db: Database, attemptId: string) {
  return db.all<IHtlcSettlementDB[]>(
    `SELECT *
     FROM htlcSettlement
     WHERE channelOpenAttemptId = $attemptId
     ORDER BY channelId, incomingChannelId, htlcId`,
    { $attemptId: attemptId },
  );
}

export async function reserveChannelOpenAttempt(
  db: Database,
  options: ReservationOptions,
): Promise<ChannelOpenReservationResult> {
  return withImmediateTransaction(db, async (transactionDb) => {
    const activeAttempt = await getActiveChannelOpenAttempt(transactionDb, options.pubkey);
    if (activeAttempt) {
      return { status: "ACTIVE_ATTEMPT", attempt: activeAttempt };
    }

    const settlements = await transactionDb.all<IHtlcSettlementDB[]>(
      `SELECT htlcSettlement.*
       FROM htlcSettlement
       JOIN channelRequest
         ON channelRequest.channelId = htlcSettlement.channelId
       WHERE channelRequest.pubkey = $pubkey
         AND htlcSettlement.settled = 1
         AND htlcSettlement.claimed = 0
         AND htlcSettlement.channelOpenAttemptId IS NULL
         AND ($channelId IS NULL OR htlcSettlement.channelId = $channelId)
       ORDER BY htlcSettlement.channelId,
                htlcSettlement.incomingChannelId,
                htlcSettlement.htlcId`,
      {
        $pubkey: options.pubkey,
        $channelId: options.requestedChannelId ?? null,
      },
    );

    if (settlements.length === 0) {
      return { status: "NO_SETTLEMENTS" };
    }

    const maximumMsat = Long.fromValue(options.maximumAmountSat).mul(MSAT);
    const settlementsByChannel = new Map<string, IHtlcSettlementDB[]>();
    for (const settlement of settlements) {
      const channelSettlements = settlementsByChannel.get(settlement.channelId) ?? [];
      channelSettlements.push(settlement);
      settlementsByChannel.set(settlement.channelId, channelSettlements);
    }

    const selected: IHtlcSettlementDB[] = [];
    let totalMsat = Long.UZERO;

    // Keep all currently settled shards for one channel request together. A
    // claim may span several requests, but it must never reserve only part of
    // a request merely because the configured channel limit was reached.
    for (const channelSettlements of settlementsByChannel.values()) {
      const channelAmountMsat = channelSettlements.reduce((amount, settlement) => {
        return amount.add(
          Long.fromString(
            settlement.amountMsat ??
              Long.fromValue(settlement.amountSat).mul(MSAT).toString(),
            true,
          ),
        );
      }, Long.UZERO);

      if (options.requestedChannelId) {
        selected.push(...channelSettlements);
        totalMsat = totalMsat.add(channelAmountMsat);
      } else if (totalMsat.add(channelAmountMsat).lessThanOrEqual(maximumMsat)) {
        selected.push(...channelSettlements);
        totalMsat = totalMsat.add(channelAmountMsat);
      }
    }

    const grossAmountSat = totalMsat.div(MSAT).toNumber();
    const requiredMsat =
      options.requiredAmountSat === undefined
        ? undefined
        : Long.fromValue(options.requiredAmountSat).mul(MSAT);
    if (
      selected.length === 0 ||
      totalMsat.greaterThan(maximumMsat) ||
      (requiredMsat !== undefined && !totalMsat.equals(requiredMsat))
    ) {
      return { status: "AMOUNT_MISMATCH", amountSat: grossAmountSat };
    }

    const pushAmountSat = grossAmountSat - options.feeSat;
    if (pushAmountSat <= 0) {
      return { status: "FEE_EXCEEDS_AMOUNT", amountSat: grossAmountSat };
    }

    const now = Date.now();
    await transactionDb.run(
      `INSERT INTO channelOpenAttempt
       (
         attemptId,
         pubkey,
         source,
         requestedChannelId,
         status,
         grossAmountSat,
         feeSat,
         pushAmountSat,
         existingChannelPoints,
         channelPoint,
         error,
         spendUnconfirmed,
         zeroConf,
         taprootChannel,
         rpcDispatched,
         dispatchCount,
         createdAt,
         updatedAt
       )
       VALUES
       (
         $attemptId,
         $pubkey,
         $source,
         $requestedChannelId,
         'OPENING',
         $grossAmountSat,
         $feeSat,
         $pushAmountSat,
         $existingChannelPoints,
         NULL,
         NULL,
         $spendUnconfirmed,
         $zeroConf,
         $taprootChannel,
         0,
         0,
         $createdAt,
         $updatedAt
       )`,
      {
        $attemptId: options.attemptId,
        $pubkey: options.pubkey,
        $source: options.source,
        $requestedChannelId: options.requestedChannelId ?? null,
        $grossAmountSat: grossAmountSat,
        $feeSat: options.feeSat,
        $pushAmountSat: pushAmountSat,
        $existingChannelPoints: JSON.stringify(options.existingChannelPoints),
        $spendUnconfirmed: options.spendUnconfirmed ? 1 : 0,
        $zeroConf: options.zeroConf ? 1 : 0,
        $taprootChannel: options.taprootChannel ? 1 : 0,
        $createdAt: now,
        $updatedAt: now,
      },
    );

    for (const settlement of selected) {
      const result = await transactionDb.run(
        `UPDATE htlcSettlement
         SET channelOpenAttemptId = $attemptId
         WHERE channelId = $channelId
           AND incomingChannelId = $incomingChannelId
           AND htlcId = $htlcId
           AND settled = 1
           AND claimed = 0
           AND channelOpenAttemptId IS NULL`,
        {
          $attemptId: options.attemptId,
          $channelId: settlement.channelId,
          $incomingChannelId: settlement.incomingChannelId,
          $htlcId: settlement.htlcId,
        },
      );
      if (result.changes !== 1) {
        throw new Error("Could not reserve an HTLC settlement for channel opening");
      }
    }

    const attempt = await getChannelOpenAttempt(transactionDb, options.attemptId);
    if (!attempt) {
      throw new Error("Channel-open attempt disappeared during reservation");
    }
    return { status: "RESERVED", attempt };
  });
}

export async function markChannelOpenAttemptDispatched(
  db: Database,
  attemptId: string,
  mode: { zeroConf: boolean; taprootChannel: boolean },
) {
  return withImmediateTransaction(db, async (transactionDb) => {
    const updatedAt = Date.now();
    const result = await transactionDb.run(
      `UPDATE channelOpenAttempt
       SET rpcDispatched = 1,
           dispatchCount = dispatchCount + 1,
           zeroConf = $zeroConf,
           taprootChannel = $taprootChannel,
           updatedAt = $updatedAt
       WHERE attemptId = $attemptId
         AND status = 'OPENING'
         AND rpcDispatched = 0`,
      {
        $attemptId: attemptId,
        $zeroConf: mode.zeroConf ? 1 : 0,
        $taprootChannel: mode.taprootChannel ? 1 : 0,
        $updatedAt: updatedAt,
      },
    );
    if (result.changes !== 1) {
      throw new Error(`Channel-open attempt ${attemptId} is not ready for dispatch`);
    }

    const attempt = await getChannelOpenAttempt(transactionDb, attemptId);
    if (!attempt) {
      throw new Error(`Channel-open attempt ${attemptId} disappeared before dispatch`);
    }
    return attempt;
  });
}

export async function touchChannelOpenAttempt(db: Database, attemptId: string) {
  await db.run(
    `UPDATE channelOpenAttempt
     SET updatedAt = $updatedAt
     WHERE attemptId = $attemptId
       AND status = 'OPENING'
       AND rpcDispatched = 1`,
    {
      $attemptId: attemptId,
      $updatedAt: Date.now(),
    },
  );
}

export async function cancelChannelOpenAttempt(
  db: Database,
  attemptId: string,
  options: {
    reason: string;
    allowDispatched: boolean;
    expectedUpdatedAt?: number;
  },
) {
  return withImmediateTransaction(db, async (transactionDb) => {
    const attempt = await getChannelOpenAttempt(transactionDb, attemptId);
    if (!attempt) {
      throw new Error(`Unknown channel-open attempt ${attemptId}`);
    }
    if (attempt.status === "OPENED" || attempt.status === "CANCELLED") {
      return attempt;
    }
    if (
      options.expectedUpdatedAt !== undefined &&
      attempt.updatedAt !== options.expectedUpdatedAt
    ) {
      throw new Error(`Channel-open attempt ${attemptId} changed during cancellation`);
    }
    if (attempt.rpcDispatched !== 0 && !options.allowDispatched) {
      throw new Error(`Channel-open attempt ${attemptId} may already have reached lnd`);
    }

    const result = await transactionDb.run(
      `UPDATE channelOpenAttempt
       SET status = 'CANCELLED',
           error = $error,
           updatedAt = $updatedAt
       WHERE attemptId = $attemptId
         AND status IN ('OPENING', 'UNKNOWN')
         AND rpcDispatched = $rpcDispatched
         AND updatedAt = $expectedUpdatedAt`,
      {
        $attemptId: attemptId,
        $error: options.reason.slice(0, 2000),
        $updatedAt: Date.now(),
        $rpcDispatched: attempt.rpcDispatched,
        $expectedUpdatedAt: attempt.updatedAt,
      },
    );
    if (result.changes !== 1) {
      throw new Error(`Channel-open attempt ${attemptId} changed during cancellation`);
    }

    await transactionDb.run(
      `UPDATE htlcSettlement
       SET channelOpenAttemptId = NULL
       WHERE channelOpenAttemptId = $attemptId
         AND claimed = 0`,
      { $attemptId: attemptId },
    );

    const cancelled = await getChannelOpenAttempt(transactionDb, attemptId);
    if (!cancelled) {
      throw new Error(`Channel-open attempt ${attemptId} disappeared during cancellation`);
    }
    return cancelled;
  });
}

export async function markChannelOpenAttemptUnknown(
  db: Database,
  attemptId: string,
  error: string,
) {
  await db.run(
    `UPDATE channelOpenAttempt
     SET status = 'UNKNOWN', error = $error, updatedAt = $updatedAt
     WHERE attemptId = $attemptId
       AND status IN ('OPENING', 'UNKNOWN')
       AND rpcDispatched = 1`,
    {
      $attemptId: attemptId,
      $error: error.slice(0, 2000),
      $updatedAt: Date.now(),
    },
  );
}

export async function finalizeChannelOpenAttempt(
  db: Database,
  attemptId: string,
  channelPoint: string,
) {
  return withImmediateTransaction(db, async (transactionDb) => {
    const attempt = await getChannelOpenAttempt(transactionDb, attemptId);
    if (!attempt) {
      throw new Error(`Unknown channel-open attempt ${attemptId}`);
    }
    if (attempt.status === "OPENED") {
      if (attempt.channelPoint !== channelPoint) {
        throw new Error(`Channel-open attempt ${attemptId} has a different channel point`);
      }
      return attempt;
    }
    if (attempt.status === "CANCELLED") {
      throw new Error(`Channel-open attempt ${attemptId} was cancelled`);
    }

    const settlements = await getChannelOpenAttemptSettlements(transactionDb, attemptId);
    if (settlements.length === 0) {
      throw new Error(`Channel-open attempt ${attemptId} has no reserved settlements`);
    }

    const settlementUpdate = await transactionDb.run(
      `UPDATE htlcSettlement
       SET claimed = 1
       WHERE channelOpenAttemptId = $attemptId
         AND settled = 1
         AND claimed = 0`,
      { $attemptId: attemptId },
    );
    if (settlementUpdate.changes !== settlements.length) {
      throw new Error(
        `Channel-open attempt ${attemptId} could not claim every reserved settlement`,
      );
    }
    await transactionDb.run(
      `UPDATE channelRequest
       SET channelPoint = $channelPoint,
           status = 'DONE',
           automaticOpenQueued = 0
       WHERE channelId IN (
         SELECT channelId
         FROM htlcSettlement
         WHERE channelOpenAttemptId = $attemptId
       )`,
      {
        $attemptId: attemptId,
        $channelPoint: channelPoint,
      },
    );
    await transactionDb.run(
      `UPDATE channelOpenAttempt
       SET status = 'OPENED',
           channelPoint = $channelPoint,
           error = NULL,
           updatedAt = $updatedAt
       WHERE attemptId = $attemptId`,
      {
        $attemptId: attemptId,
        $channelPoint: channelPoint,
        $updatedAt: Date.now(),
      },
    );

    const finalized = await getChannelOpenAttempt(transactionDb, attemptId);
    if (!finalized) {
      throw new Error(`Channel-open attempt ${attemptId} disappeared during finalization`);
    }
    return finalized;
  });
}
