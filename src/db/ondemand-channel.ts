import { Database } from "sqlite";
import Long from "long";

import { MSAT } from "../utils/constants";

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
  incomingChannelId: number;
  htlcId: number;
  amountSat: number;
  amountMsat?: string | null;
  settled: number;
  claimed: number;
  channelOpenAttemptId?: string | null;
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
        claimed
      )
    VALUES
      (
        $channelId,
        $incomingChannelId,
        $htlcId,
        $amountSat,
        $amountMsat,
        $settled,
        $claimed
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
    },
  );
}

export async function getHtlcSettlement(
  db: Database,
  channelId: string,
  incomingChannelId: number,
  htlcId: number,
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
