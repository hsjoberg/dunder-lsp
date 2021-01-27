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
  expire: number;
  expectedAmountSat: number | null;
  actualSettledAmountSat: number | null;
}

export async function createChannelRequest(
  db: Database,
  { channelId, pubkey, preimage, status, expire, expectedAmountSat }: IChannelRequestDB,
) {
  await db.run(
    `INSERT INTO channelRequest
      (
        channelId,
        pubkey,
        preimage,
        status,
        expire,
        expectedAmountSat
      )
      VALUES
      (
        $channelId,
        $pubkey,
        $preimage,
        $status,
        $expire,
        $expectedAmountSat
      )
    `,
    {
      $channelId: channelId,
      $pubkey: pubkey,
      $preimage: preimage,
      $status: status,
      $expire: expire,
      $expectedAmountSat: expectedAmountSat,
    },
  );
}

/**
 * Note: Updating pubkey, preimage and expire is not allowed
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
    actualSettledAmountSat,
  }: IChannelRequestDB,
) {
  await db.run(
    `UPDATE channelRequest
    SET status = $status,
        expectedAmountSat = $expectedAmountSat,
        actualSettledAmountSat = $actualSettledAmountSat
    WHERE channelId = $channelId
    `,
    {
      $channelId: channelId,
      $status: status,
      $expectedAmountSat: expectedAmountSat,
      $actualSettledAmountSat: actualSettledAmountSat,
    },
  );
}

/**
 * Note: Updating pubkey, preimage and expire is not allowed
 */
export async function updateChannelRequestByPubkey(
  db: Database,
  {
    channelId,
    pubkey,
    preimage,
    status,
    expire,
    expectedAmountSat,
    actualSettledAmountSat,
  }: IChannelRequestDB,
) {
  await db.run(
    `UPDATE channelRequest
    SET status = $status,
        expectedAmountSat = $expectedAmountSat,
        actualSettledAmountSat = $actualSettledAmountSat
    WHERE pubkey = $pubkey
    `,
    {
      $pubkey: pubkey,
      $status: status,
      $expectedAmountSat: expectedAmountSat,
      $actualSettledAmountSat: actualSettledAmountSat,
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
