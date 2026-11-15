import { status as grpcStatus } from "@grpc/grpc-js";
import Long from "long";

import getDb from "../../../src/db/db";
import {
  createChannelRequest,
  createHtlcSettlement,
  getHtlcSettlement,
} from "../../../src/db/ondemand-channel";
import { getActiveChannelOpenAttempt } from "../../../src/db/channel-open-attempt";
import {
  AMBIGUOUS_RELEASE_DELAY_MS,
  LND_REJECTED_RELEASE_DELAY_MS,
  classifyChannelOpenError,
  openChannelForSettledHtlcs,
  reconcileUnsettledHtlcSettlements,
  recoverChannelOpenState,
} from "../../../src/services/ondemand-channel/channel-open";
import { lnrpc } from "../../../src/proto";

import {
  closedChannels,
  lookupHtlcResolution,
  openChannelSync,
  walletBalance,
} from "../../../mocks/utils/lnd-api";

const PUBKEY = "abcdef12345";

function grpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code, details: message });
}

async function seedSettled(
  db: Awaited<ReturnType<typeof getDb>>,
  { channelId = "recovery-channel", settled = 1 } = {},
) {
  await createChannelRequest(db, {
    channelId,
    pubkey: PUBKEY,
    preimage: `preimage-${channelId}`,
    status: "REGISTERED",
    start: 0,
    expire: 600,
    expectedAmountSat: 5000,
    channelPoint: null,
  });
  await createHtlcSettlement(db, {
    channelId,
    incomingChannelId: "1",
    htlcId: "1",
    amountSat: 5000,
    settled,
    claimed: 0,
  });
}

function open(db: Awaited<ReturnType<typeof getDb>>) {
  return openChannelForSettledHtlcs({
    db,
    lightning: {} as any,
    pubkey: PUBKEY,
    source: "CLAIM",
    zeroConf: false,
    taprootChannel: false,
  });
}

async function ageAttempt(db: Awaited<ReturnType<typeof getDb>>, byMs: number) {
  await db.run("UPDATE channelOpenAttempt SET updatedAt = updatedAt - ?", byMs);
}

describe("resolving failed channel opens", () => {
  beforeEach(() => {
    (openChannelSync as jest.Mock).mockReset();
    (openChannelSync as jest.Mock).mockResolvedValue(
      lnrpc.ChannelPoint.create({ fundingTxidStr: "txid", outputIndex: 0 }),
    );
    (closedChannels as jest.Mock).mockClear();
    (walletBalance as jest.Mock).mockClear();
  });

  test("classifies lnd's own errors separately from transport errors", () => {
    expect(classifyChannelOpenError(grpcError(grpcStatus.UNKNOWN, "insufficient funds"))).toBe(
      "LND_REJECTED",
    );
    expect(classifyChannelOpenError(grpcError(grpcStatus.UNAVAILABLE, "connection reset"))).toBe(
      "AMBIGUOUS",
    );
    expect(classifyChannelOpenError(grpcError(grpcStatus.DEADLINE_EXCEEDED, "deadline"))).toBe(
      "AMBIGUOUS",
    );
    expect(classifyChannelOpenError(new Error("no code"))).toBe("AMBIGUOUS");
  });

  test("releases an open lnd rejected, then backs off before retrying", async () => {
    const db = await getDb(true);
    await seedSettled(db);
    (openChannelSync as jest.Mock).mockRejectedValueOnce(
      grpcError(grpcStatus.UNKNOWN, "peer rejected the channel"),
    );

    await expect(open(db)).resolves.toMatchObject({ status: "UNKNOWN" });
    const attempt = await getActiveChannelOpenAttempt(db, PUBKEY);
    expect(attempt?.failureKind).toBe("LND_REJECTED");

    // Not released before the short re-check delay.
    await recoverChannelOpenState(db, {} as any);
    expect((await getActiveChannelOpenAttempt(db, PUBKEY))?.status).toBe("UNKNOWN");

    await ageAttempt(db, LND_REJECTED_RELEASE_DELAY_MS);
    await recoverChannelOpenState(db, {} as any);

    expect(await getActiveChannelOpenAttempt(db, PUBKEY)).toBeUndefined();
    expect((await getHtlcSettlement(db, "recovery-channel", "1", "1"))?.channelOpenAttemptId).toBeNull();
    // The payout is not retried immediately.
    await expect(open(db)).resolves.toMatchObject({ status: "BACKOFF" });
    expect(openChannelSync).toBeCalledTimes(1);
  });

  test("keeps an ambiguous open reserved until lnd's funding flow can have timed out", async () => {
    const db = await getDb(true);
    await seedSettled(db);
    (openChannelSync as jest.Mock).mockRejectedValueOnce(
      grpcError(grpcStatus.UNAVAILABLE, "connection reset"),
    );

    await expect(open(db)).resolves.toMatchObject({ status: "UNKNOWN" });
    await ageAttempt(db, AMBIGUOUS_RELEASE_DELAY_MS - 60_000);
    await recoverChannelOpenState(db, {} as any);
    expect((await getActiveChannelOpenAttempt(db, PUBKEY))?.status).toBe("UNKNOWN");

    await ageAttempt(db, 60_000);
    await recoverChannelOpenState(db, {} as any);
    expect(await getActiveChannelOpenAttempt(db, PUBKEY)).toBeUndefined();
  });

  test("never releases an attempt when lnd shows a new closed channel to the peer", async () => {
    const db = await getDb(true);
    await seedSettled(db);
    (openChannelSync as jest.Mock).mockRejectedValueOnce(
      grpcError(grpcStatus.UNKNOWN, "funding failed"),
    );
    await expect(open(db)).resolves.toMatchObject({ status: "UNKNOWN" });

    (closedChannels as jest.Mock).mockResolvedValue(
      lnrpc.ClosedChannelsResponse.create({
        channels: [{ remotePubkey: PUBKEY, channelPoint: "opened-and-closed:0" }],
      }),
    );
    try {
      await ageAttempt(db, AMBIGUOUS_RELEASE_DELAY_MS);
      await recoverChannelOpenState(db, {} as any);
      expect((await getActiveChannelOpenAttempt(db, PUBKEY))?.status).toBe("UNKNOWN");
    } finally {
      (closedChannels as jest.Mock).mockResolvedValue(
        lnrpc.ClosedChannelsResponse.create({ channels: [] }),
      );
    }
  });

  test("releases an open whose process died mid-RPC, once lnd's funding flow has ended", async () => {
    const db = await getDb(true);
    await seedSettled(db);
    // OpenChannelSync never returns: the process "crashes" mid-RPC and the
    // attempt is left OPENING with rpcDispatched = 1.
    (openChannelSync as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));
    void open(db);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const attempt = await getActiveChannelOpenAttempt(db, PUBKEY);
    expect(attempt).toMatchObject({ status: "OPENING", rpcDispatched: 1 });

    await ageAttempt(db, 10 * 60_000);
    await recoverChannelOpenState(db, {} as any);
    expect((await getActiveChannelOpenAttempt(db, PUBKEY))?.status).toBe("OPENING");

    await ageAttempt(db, AMBIGUOUS_RELEASE_DELAY_MS);
    await recoverChannelOpenState(db, {} as any);

    // Released, and the same recovery pass pays the request out with a new
    // attempt (a crash isn't the peer's fault, so there is no backoff).
    const attempts = await db.all<{ attemptId: string; status: string }[]>(
      "SELECT attemptId, status FROM channelOpenAttempt ORDER BY createdAt",
    );
    expect(attempts.map((row) => row.status)).toEqual(["CANCELLED", "OPENED"]);
    expect(
      (await getHtlcSettlement(db, "recovery-channel", "1", "1"))?.channelOpenAttemptId,
    ).toBe(attempts[1].attemptId);
    expect(openChannelSync).toBeCalledTimes(2);
  });

  test("does not dispatch an open the wallet can't fund", async () => {
    const db = await getDb(true);
    await seedSettled(db);
    (walletBalance as jest.Mock).mockResolvedValueOnce(
      lnrpc.WalletBalanceResponse.create({ confirmedBalance: Long.fromValue(50_000) }),
    );

    await expect(open(db)).resolves.toEqual({ status: "INSUFFICIENT_FUNDS" });
    expect(openChannelSync).not.toBeCalled();
    expect(await getActiveChannelOpenAttempt(db, PUBKEY)).toBeUndefined();
  });
});

describe("reconciling unsettled HTLC records with lnd", () => {
  test("marks settled HTLCs and removes failed ones", async () => {
    const db = await getDb(true);
    await seedSettled(db, { channelId: "settled-in-lnd", settled: 0 });
    await createChannelRequest(db, {
      channelId: "failed-in-lnd",
      pubkey: PUBKEY,
      preimage: "preimage-failed-in-lnd",
      status: "REGISTERED",
      start: 0,
      expire: 600,
      expectedAmountSat: 5000,
      channelPoint: null,
    });
    await createHtlcSettlement(db, {
      channelId: "failed-in-lnd",
      incomingChannelId: "2",
      htlcId: "9",
      amountSat: 5000,
      settled: 0,
      claimed: 0,
    });
    (lookupHtlcResolution as jest.Mock)
      .mockResolvedValueOnce(lnrpc.LookupHtlcResolutionResponse.create({ settled: true }))
      .mockResolvedValueOnce(lnrpc.LookupHtlcResolutionResponse.create({ settled: false }));

    const settledChannels = await reconcileUnsettledHtlcSettlements(db, {} as any);

    expect([...settledChannels]).toEqual(["settled-in-lnd"]);
    expect((await getHtlcSettlement(db, "settled-in-lnd", "1", "1"))?.settled).toBe(1);
    expect(await getHtlcSettlement(db, "failed-in-lnd", "2", "9")).toBeUndefined();
  });

  test("leaves rows alone while lnd has no resolution", async () => {
    const db = await getDb(true);
    await seedSettled(db, { channelId: "still-pending", settled: 0 });

    await reconcileUnsettledHtlcSettlements(db, {} as any);

    expect((await getHtlcSettlement(db, "still-pending", "1", "1"))?.settled).toBe(0);
  });
});
