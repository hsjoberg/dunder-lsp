import { Database } from "sqlite";
import Long from "long";

import { MSAT } from "../utils/constants";
import { withImmediateTransaction } from "./db";

export type ChannelRequestStatus =
  | "NOT_REGISTERED"
  | "REGISTERED"
  | "WAITING_FOR_SETTLEMENT"
  | "SETTLED"
  | "DONE";

export interface IChannelRequestDB {
  channelId: string;
  pubkey: string;
  preimage: string;
  status: ChannelRequestStatus;
  start: number;
  expire: number;
  expectedAmountSat: number;
  channelPoint: string | null;
  automaticOpenQueued?: number;
}

export interface IHtlcSettlementDB {
  channelId: string;
  /** Decimal string of lnd's uint64 incoming channel ID. */
  incomingChannelId: string;
  /** Decimal string of lnd's uint64 HTLC index on the incoming channel. */
  htlcId: string;
  amountSat: number;
  amountMsat?: string | null;
  settled: number;
  claimed: number;
  channelOpenAttemptId?: string | null;
  /** Block height at which the incoming HTLC expires. */
  incomingExpiry?: number | null;
  /** Decimal msat the incoming HTLC carried. */
  incomingAmountMsat?: string | null;
  /** Funding outpoint ("txid:index") of the incoming channel. */
  incomingChannelPoint?: string | null;
}

export async function createChannelRequest(
  db: Database,
  {
    channelId,
    pubkey,
    preimage,
    status,
    start,
    expire,
    expectedAmountSat,
    channelPoint,
  }: IChannelRequestDB,
) {
  await db.run(
    `INSERT INTO channelRequest
      (
        channelId,
        pubkey,
        preimage,
        start,
        status,
        expire,
        expectedAmountSat,
        channelPoint,
        automaticOpenQueued
      )
    VALUES
      (
        $channelId,
        $pubkey,
        $preimage,
        $start,
        $status,
        $expire,
        $expectedAmountSat,
        $channelPoint,
        1
      )
    `,
    {
      $channelId: channelId,
      $pubkey: pubkey,
      $preimage: preimage,
      $status: status,
      $start: start,
      $expire: expire,
      $expectedAmountSat: expectedAmountSat,
      $channelPoint: channelPoint,
    },
  );
}

/**
 * Note: Updating pubkey, preimage, start or expire is not allowed
 */
export async function updateChannelRequest(
  db: Database,
  {
    channelId,
    pubkey,
    preimage,
    status,
    expire,
    expectedAmountSat,
    channelPoint,
  }: IChannelRequestDB,
) {
  await db.run(
    `UPDATE channelRequest
    SET status = $status,
        expectedAmountSat = $expectedAmountSat,
        channelPoint = $channelPoint
    WHERE channelId = $channelId`,
    {
      $channelId: channelId,
      $status: status,
      $expectedAmountSat: expectedAmountSat,
      $channelPoint: channelPoint,
    },
  );
}

export function getActiveChannelRequestsByPubkey(db: Database, pubkey: string) {
  return db.all<IChannelRequestDB[]>(`SELECT * FROM channelRequest WHERE $pubkey = pubkey`, {
    $pubkey: pubkey,
  });
}

export function getChannelRequest(db: Database, channelId: string) {
  return db.get<IChannelRequestDB>(`SELECT * FROM channelRequest WHERE channelId = $channelId`, {
    $channelId: channelId,
  });
}

export async function getChannelRequestUnclaimedAmount(db: Database, pubkey: string) {
  const results = await db.all<{ amountSat: number; amountMsat: string | null }[]>(
    `SELECT htlcSettlement.amountSat, htlcSettlement.amountMsat
    FROM htlcSettlement
    JOIN channelRequest
      ON  channelRequest.channelId = htlcSettlement.channelId
      AND channelRequest.pubkey = $pubkey
    WHERE htlcSettlement.settled = $settled AND htlcSettlement.claimed = $claimed`,
    {
      $pubkey: pubkey,
      $settled: 1,
      $claimed: 0,
    },
  );
  const totalMsat = results.reduce((total, settlement) => {
    const amountMsat =
      settlement.amountMsat ?? Long.fromValue(settlement.amountSat).mul(MSAT).toString();
    return total.add(Long.fromString(amountMsat, true));
  }, Long.UZERO);
  return totalMsat.div(MSAT).toNumber();
}

export async function createHtlcSettlement(
  db: Database,
  {
    channelId,
    htlcId,
    incomingChannelId,
    amountSat,
    amountMsat,
    settled,
    claimed,
    incomingExpiry,
    incomingAmountMsat,
    incomingChannelPoint,
  }: IHtlcSettlementDB,
) {
  const storedAmountMsat = amountMsat ?? Long.fromValue(amountSat).mul(MSAT).toString();
  await db.run(
    `INSERT INTO htlcSettlement
      (
        channelId,
        incomingChannelId,
        htlcId,
        amountSat,
        amountMsat,
        settled,
        claimed,
        incomingExpiry,
        incomingAmountMsat,
        incomingChannelPoint
      )
    VALUES
      (
        $channelId,
        $incomingChannelId,
        $htlcId,
        $amountSat,
        $amountMsat,
        $settled,
        $claimed,
        $incomingExpiry,
        $incomingAmountMsat,
        $incomingChannelPoint
      )
    `,
    {
      $channelId: channelId,
      $incomingChannelId: incomingChannelId,
      $htlcId: htlcId,
      $amountSat: amountSat,
      $amountMsat: storedAmountMsat,
      $settled: settled,
      $claimed: claimed,
      $incomingExpiry: incomingExpiry ?? null,
      $incomingAmountMsat: incomingAmountMsat ?? null,
      $incomingChannelPoint: incomingChannelPoint ?? null,
    },
  );
}

export async function getHtlcSettlement(
  db: Database,
  channelId: string,
  incomingChannelId: string,
  htlcId: string,
) {
  return db.get<IHtlcSettlementDB>(
    `SELECT * FROM htlcSettlement WHERE channelId = $channelId AND incomingChannelId = $incomingChannelId AND htlcId = $htlcId`,
    {
      $channelId: channelId,
      $incomingChannelId: incomingChannelId,
      $htlcId: htlcId,
    },
  );
}

// TODO(hsjoberg): function is not used anywhere
export async function getHtlcSettlements(db: Database, channelId: string) {
  return db.all<IHtlcSettlementDB[]>(`SELECT * FROM htlcSettlement WHERE channelId = $channelId`, {
    $channelId: channelId,
  });
}

export async function updateHtlcSettlement(
  db: Database,
  { channelId, incomingChannelId, htlcId, amountSat, settled, claimed }: IHtlcSettlementDB,
) {
  await db.run(
    `UPDATE htlcSettlement
    SET   amountSat = $amountSat,
          settled = $settled,
          claimed = $claimed
    WHERE channelId = $channelId AND incomingChannelId = $incomingChannelId AND htlcId = $htlcId`,
    {
      $amountSat: amountSat,
      $settled: settled,
      $claimed: claimed,
      $channelId: channelId,
      $incomingChannelId: incomingChannelId,
      $htlcId: htlcId,
    },
  );
}

export async function checkAllHtclSettlementsSettled(db: Database, channelId: string) {
  const result = await db.all<{ settled: 0 | 1 }[]>(
    `SELECT settled FROM htlcSettlement WHERE channelId = $channelId`,
    { $channelId: channelId },
  );

  if (result.length === 0) {
    return false;
  }

  return result.every(({ settled }) => settled === 1);
}

/**
 * Records every part of a payment in one transaction before any SETTLE is sent
 * to lnd, so a settled HTLC can never exist without its database row.
 */
export async function createHtlcSettlements(db: Database, settlements: IHtlcSettlementDB[]) {
  await withImmediateTransaction(db, async (transactionDb) => {
    for (const settlement of settlements) {
      await createHtlcSettlement(transactionDb, settlement);
    }
  });
}

/** Looks up a settlement by lnd's incoming circuit key, which is unique per HTLC. */
export function getHtlcSettlementByCircuitKey(
  db: Database,
  incomingChannelId: string,
  htlcId: string,
) {
  return db.get<IHtlcSettlementDB>(
    `SELECT * FROM htlcSettlement
     WHERE incomingChannelId = $incomingChannelId AND htlcId = $htlcId`,
    { $incomingChannelId: incomingChannelId, $htlcId: htlcId },
  );
}

/** Returns true if the row was newly marked as settled. */
export async function markHtlcSettlementSettled(
  db: Database,
  incomingChannelId: string,
  htlcId: string,
) {
  const result = await db.run(
    `UPDATE htlcSettlement
     SET settled = 1
     WHERE incomingChannelId = $incomingChannelId AND htlcId = $htlcId AND settled = 0`,
    { $incomingChannelId: incomingChannelId, $htlcId: htlcId },
  );
  return (result.changes ?? 0) > 0;
}

/**
 * Removes the record of an HTLC that lnd failed back instead of settling, so
 * the money never arrived. Only unsettled, unreserved rows are removed.
 */
export async function deleteFailedHtlcSettlement(
  db: Database,
  incomingChannelId: string,
  htlcId: string,
) {
  const result = await db.run(
    `DELETE FROM htlcSettlement
     WHERE incomingChannelId = $incomingChannelId
       AND htlcId = $htlcId
       AND settled = 0
       AND claimed = 0
       AND channelOpenAttemptId IS NULL`,
    { $incomingChannelId: incomingChannelId, $htlcId: htlcId },
  );
  return (result.changes ?? 0) > 0;
}

export function getUnsettledHtlcSettlements(db: Database) {
  return db.all<IHtlcSettlementDB[]>(`SELECT * FROM htlcSettlement WHERE settled = 0`);
}

export async function hasHtlcSettlements(db: Database, channelId: string) {
  const row = await db.get<{ found: number }>(
    `SELECT 1 AS found FROM htlcSettlement WHERE channelId = $channelId LIMIT 1`,
    { $channelId: channelId },
  );
  return !!row;
}

/**
 * Counts requests for a pubkey that can still receive a payment: registered,
 * not expired and not paid yet.
 */
export async function countOpenChannelRequests(
  db: Database,
  pubkey: string,
  nowUnix: number,
  expiryGraceSeconds: number,
) {
  const row = await db.get<{ total: number }>(
    `SELECT COUNT(*) AS total
     FROM channelRequest
     WHERE pubkey = $pubkey
       AND status = 'REGISTERED'
       AND start + expire + $grace > $now
       AND NOT EXISTS (
         SELECT 1 FROM htlcSettlement WHERE htlcSettlement.channelId = channelRequest.channelId
       )`,
    { $pubkey: pubkey, $grace: expiryGraceSeconds, $now: nowUnix },
  );
  return row?.total ?? 0;
}
