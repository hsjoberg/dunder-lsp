import { Database } from "sqlite";

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
}

export interface IHtlcSettlementDB {
  channelId: string;
  htlcId: number;
  amountSat: number;
  settled: number;
  claimed: number;
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
        channelPoint
      )
    VALUES
      (
        $channelId,
        $pubkey,
        $preimage,
        $status,
        $start,
        $expire,
        $expectedAmountSat,
        $channelPoint
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
  const result = await db.get<{ amountSat: number }>(
    `SELECT SUM(htlcSettlement.amountSat) as amountSat
    FROM htlcSettlement
    JOIN channelRequest
      ON  channelRequest.channelId = htlcSettlement.channelId
      AND channelRequest.pubkey = $pubkey
    WHERE htlcSettlement.settled = $settled`,
    {
      $pubkey: pubkey,
      $settled: 0,
    },
  );
  return result?.amountSat ?? 0;
}

export async function createHtlcSettlement(
  db: Database,
  { channelId, htlcId, amountSat, settled, claimed }: IHtlcSettlementDB,
) {
  await db.run(
    `INSERT INTO htlcSettlement
      (
        channelId,
        htlcId,
        amountSat,
        settled,
        claimed
      )
    VALUES
      (
        $channelId,
        $htlcId,
        $amountSat,
        $settled,
        $claimed
      )
    `,
    {
      $channelId: channelId,
      $htlcId: htlcId,
      $amountSat: amountSat,
      $settled: settled,
      $claimed: claimed,
    },
  );
}

export async function getHtlcSettlement(db: Database, channelId: string, htlcId: number) {
  return db.get<IHtlcSettlementDB>(
    `SELECT * FROM htlcSettlement WHERE channelId = $channelId and htlcId = $htlcId`,
    {
      $channelId: channelId,
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
  { channelId, htlcId, amountSat, settled, claimed }: IHtlcSettlementDB,
) {
  await db.run(
    `UPDATE htlcSettlement
    SET   amountSat = $amountSat,
          settled = $settled,
          claimed = $claimed
    WHERE channelId = $channelId AND htlcId = $htlcId`,
    {
      $amountSat: amountSat,
      $settled: settled,
      $claimed: claimed,
      $channelId: channelId,
      $htlcId: htlcId,
    },
  );
}

export async function updateHtlcSettlementSetAllAsClaimed(db: Database, pubkey: string) {
  await db.run(
    `UPDATE htlcSettlement
    SET claimed = $claimed
    JOIN  channelRequest ON channelRequest.channelId = htlcSettlement.channelId
    AND   channelRequest.pubkey = $pubkey`,
    {
      $pubkey: pubkey,
      $claimed: 1,
    },
  );
}

export async function updateHtlcSettlementByChannelIdSetAsClaimed(db: Database, channelId: string) {
  await db.run(
    `UPDATE htlcSettlement
    SET claimed = $claimed
    WHERE channelId = $channelId`,
    {
      $channelId: channelId,
      $claimed: 1,
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
