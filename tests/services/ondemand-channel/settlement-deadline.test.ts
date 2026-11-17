import Long from "long";
import { getUnixTime } from "date-fns";

import getDb from "../../../src/db/db";
import { createChannelRequest, createHtlcSettlements } from "../../../src/db/ondemand-channel";
import {
  FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY,
  OVERDUE_BLOCKS_AFTER_EXPIRY,
  forceCloseChannelsWithStalledSettlements,
} from "../../../src/services/ondemand-channel/settlement-deadline";
import {
  __MOCK_BLOCK_HEIGHT,
  __setListChannelsResponse,
  forceCloseChannel,
} from "../../../mocks/utils/lnd-api";

const INCOMING_CHANNEL = "700000";
let counter = 0;

/** A request with one part recorded for settlement on INCOMING_CHANNEL, htlc 3. */
async function recordPart(blocksLeft: number, settled = 0) {
  const db = await getDb(true);
  const channelId = String(950_000 + ++counter);
  await createChannelRequest(db, {
    channelId,
    pubkey: "abcdef12345",
    preimage: "ab".repeat(32),
    status: "REGISTERED",
    start: getUnixTime(new Date()),
    expire: 600,
    expectedAmountSat: 20_000,
    channelPoint: null,
  });
  await createHtlcSettlements(db, [
    {
      channelId,
      incomingChannelId: INCOMING_CHANNEL,
      htlcId: "3",
      amountSat: 20_000,
      amountMsat: "20000000",
      incomingExpiry: __MOCK_BLOCK_HEIGHT + blocksLeft,
      settled,
      claimed: 0,
    },
  ]);
  return db;
}

function openChannel(pendingHtlcIndexes: number[], amountSat = 20_000) {
  __setListChannelsResponse({
    channels: [
      {
        chanId: Long.fromString(INCOMING_CHANNEL, true),
        channelPoint: "aa".repeat(32) + ":1",
        remotePubkey: "02payer",
        localConstraints: { dustLimitSat: Long.fromValue(354, true) },
        pendingHtlcs: pendingHtlcIndexes.map((index) => ({
          incoming: true,
          htlcIndex: Long.fromValue(index, true),
          amount: Long.fromValue(amountSat),
        })),
      },
    ],
  });
}

describe("settlement deadline guard", () => {
  beforeEach(() => {
    (forceCloseChannel as jest.Mock).mockClear();
  });
  afterAll(() => {
    __setListChannelsResponse({ channels: [] });
  });

  test("force-closes the incoming channel of a part still pending close to its expiry", async () => {
    const db = await recordPart(FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY);
    openChannel([3]);

    expect(await forceCloseChannelsWithStalledSettlements(db, {} as any)).toEqual([
      "aa".repeat(32) + ":1",
    ]);
    expect(forceCloseChannel).toHaveBeenCalledWith({}, "aa".repeat(32) + ":1");
  });

  test("leaves a part alone while its expiry is further away", async () => {
    const db = await recordPart(FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY + 1);
    openChannel([3]);

    expect(await forceCloseChannelsWithStalledSettlements(db, {} as any)).toEqual([]);
    expect(forceCloseChannel).not.toHaveBeenCalled();
  });

  test("leaves a part alone once lnd reported it settled", async () => {
    const db = await recordPart(5, 1);
    openChannel([3]);

    expect(await forceCloseChannelsWithStalledSettlements(db, {} as any)).toEqual([]);
  });

  test("leaves the channel open when the HTLC is no longer pending (a missed final event)", async () => {
    const db = await recordPart(5);
    openChannel([4]);

    expect(await forceCloseChannelsWithStalledSettlements(db, {} as any)).toEqual([]);
    expect(forceCloseChannel).not.toHaveBeenCalled();
  });

  test("doesn't force-close for a part below the dust limit (nothing to claim on-chain)", async () => {
    const db = await recordPart(5);
    openChannel([3], 353);

    expect(await forceCloseChannelsWithStalledSettlements(db, {} as any)).toEqual([]);
    expect(forceCloseChannel).not.toHaveBeenCalled();
  });

  test("warns once about a part with no final outcome long after its expiry", async () => {
    const db = await recordPart(-OVERDUE_BLOCKS_AFTER_EXPIRY - 1);
    __setListChannelsResponse({ channels: [] });
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await forceCloseChannelsWithStalledSettlements(db, {} as any);
      await forceCloseChannelsWithStalledSettlements(db, {} as any);
      const warnings = error.mock.calls.filter(([message]) =>
        String(message).includes("no final outcome long after its expiry"),
      );
      expect(warnings).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test("does nothing when the channel is already closed (lnd handles it on-chain)", async () => {
    const db = await recordPart(5);
    __setListChannelsResponse({ channels: [] });

    expect(await forceCloseChannelsWithStalledSettlements(db, {} as any)).toEqual([]);
  });
});
