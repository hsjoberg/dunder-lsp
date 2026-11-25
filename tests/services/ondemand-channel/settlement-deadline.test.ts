import Long from "long";
import { getUnixTime } from "date-fns";

import getDb from "../../../src/db/db";
import { createChannelRequest, createHtlcSettlements } from "../../../src/db/ondemand-channel";
import {
  BLOCKS_NEEDED_AFTER_CLOSE,
  DEFAULT_FEE_BUMP_MAX_SAT,
  FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY,
  OVERDUE_BLOCKS_AFTER_EXPIRY,
  bumpClosesWithStalledSettlements,
  forceCloseChannelsWithStalledSettlements,
  forgetFeeBumps,
} from "../../../src/services/ondemand-channel/settlement-deadline";
import { lnrpc } from "../../../src/proto";
import {
  __MOCK_BLOCK_HEIGHT,
  __setListChannelsResponse,
  __setPendingChannelsResponse,
  bumpForceCloseFee,
  forceCloseChannel,
} from "../../../mocks/utils/lnd-api";

const INCOMING_CHANNEL = "700000";
let counter = 0;

/** A request with one part recorded for settlement on INCOMING_CHANNEL, htlc 3. */
async function recordPart(
  blocksLeft: number,
  settled = 0,
  { amountSat = 20_000, incomingChannelPoint = "aa".repeat(32) + ":1" } = {},
) {
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
      amountSat,
      amountMsat: String(amountSat * 1000),
      incomingExpiry: __MOCK_BLOCK_HEIGHT + blocksLeft,
      incomingChannelPoint,
      settled,
      claimed: 0,
    },
  ]);
  return db;
}

function closing(channelPoint: string, commitmentType = lnrpc.CommitmentType.ANCHORS) {
  __setPendingChannelsResponse({
    waitingCloseChannels: [{ channel: { channelPoint, commitmentType } }],
  });
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

  test("ignores the fee rate, which the channel opener controls, on channels without anchors", async () => {
    const db = await recordPart(5);
    __setListChannelsResponse({
      channels: [
        {
          chanId: Long.fromString(INCOMING_CHANNEL, true),
          channelPoint: "aa".repeat(32) + ":1",
          commitmentType: lnrpc.CommitmentType.STATIC_REMOTE_KEY,
          // A fee rate raised so far that lnd would trim even a 200,000 sat HTLC.
          feePerKw: Long.fromValue(300_000, true),
          localConstraints: { dustLimitSat: Long.fromValue(354, true) },
          pendingHtlcs: [
            { incoming: true, htlcIndex: Long.fromValue(3, true), amount: Long.fromValue(200_000) },
          ],
        },
      ],
    });

    expect(await forceCloseChannelsWithStalledSettlements(db, {} as any)).toEqual([
      "aa".repeat(32) + ":1",
    ]);
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

describe("fee bumps for closes that hold settled parts", () => {
  beforeEach(() => {
    bumpForceCloseFee.mockClear();
  });
  afterAll(() => {
    __setPendingChannelsResponse({ waitingCloseChannels: [] });
  });

  test("bumps the close to confirm in time for the claim, with half the parts' value as budget", async () => {
    const channelPoint = "b1".repeat(32) + ":0";
    const db = await recordPart(FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY, 0, {
      incomingChannelPoint: channelPoint,
    });
    closing(channelPoint);

    expect(await bumpClosesWithStalledSettlements(db, {} as any)).toEqual([channelPoint]);
    expect(bumpForceCloseFee).toHaveBeenCalledWith(
      {},
      channelPoint,
      FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY - BLOCKS_NEEDED_AFTER_CLOSE,
      10_000,
    );

    // Not asked again with the same budget; the deadline is already set.
    expect(await bumpClosesWithStalledSettlements(db, {} as any)).toEqual([]);
    expect(bumpForceCloseFee).toHaveBeenCalledTimes(1);

    // lnd restarted (the interceptor stream reset) and forgot the settings.
    forgetFeeBumps();
    expect(await bumpClosesWithStalledSettlements(db, {} as any)).toEqual([channelPoint]);
    expect(bumpForceCloseFee).toHaveBeenCalledTimes(2);
  });

  test("never budgets more than the configured maximum", async () => {
    const channelPoint = "b2".repeat(32) + ":0";
    const db = await recordPart(30, 0, {
      amountSat: 1_000_000,
      incomingChannelPoint: channelPoint,
    });
    closing(channelPoint);

    await bumpClosesWithStalledSettlements(db, {} as any);
    expect(bumpForceCloseFee.mock.calls[0][3]).toBe(DEFAULT_FEE_BUMP_MAX_SAT);
  });

  test("tries again on the next run when lnd can't bump yet", async () => {
    const channelPoint = "b3".repeat(32) + ":0";
    const db = await recordPart(30, 0, { incomingChannelPoint: channelPoint });
    closing(channelPoint);
    bumpForceCloseFee.mockRejectedValueOnce(new Error("unable to find pending anchor outputs"));
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await bumpClosesWithStalledSettlements(db, {} as any)).toEqual([]);
      expect(await bumpClosesWithStalledSettlements(db, {} as any)).toEqual([channelPoint]);
      expect(bumpForceCloseFee).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

  test("leaves alone channels without anchors, other channels, and parts lnd settled or that expired", async () => {
    const channelPoint = "b4".repeat(32) + ":0";
    // Each case on a fresh database (recordPart reopens it).
    for (const [settled, blocksLeft, type, point] of [
      [0, 30, lnrpc.CommitmentType.STATIC_REMOTE_KEY, channelPoint],
      [0, 30, lnrpc.CommitmentType.ANCHORS, "b5".repeat(32) + ":0"],
      [1, 30, lnrpc.CommitmentType.ANCHORS, channelPoint],
      [0, 0, lnrpc.CommitmentType.ANCHORS, channelPoint],
    ] as const) {
      const db = await recordPart(blocksLeft, settled, { incomingChannelPoint: channelPoint });
      closing(point, type);
      expect(await bumpClosesWithStalledSettlements(db, {} as any)).toEqual([]);
    }
    expect(bumpForceCloseFee).not.toHaveBeenCalled();
  });
});
