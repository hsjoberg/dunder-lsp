import waitForExpect from "wait-for-expect";

import Claim from "../../../../src/services/ondemand-channel/api/claim";
import getDb from "../../../../src/db/db";
import {
  createChannelRequest,
  createHtlcSettlement,
  getChannelRequestUnclaimedAmount,
  getHtlcSettlement,
} from "../../../../src/db/ondemand-channel";
import { getActiveChannelOpenAttempt } from "../../../../src/db/channel-open-attempt";
import {
  getChannelOpenAttemptMemo,
  openChannelForSettledHtlcs,
  recoverChannelOpenState,
} from "../../../../src/services/ondemand-channel/channel-open";
import { lnrpc } from "../../../../src/proto";
import { stringToUint8Array } from "../../../../src/utils/common";

import {
  __setListChannelsResponse,
  __setPendingChannelsResponse,
  openChannelSync,
} from "../../../../mocks/utils/lnd-api";

const PUBKEY = "abcdef12345";

function claimRequest(pubkey = PUBKEY) {
  return {
    body: JSON.stringify({
      pubkey,
      signature: "validsig",
    }),
  } as any;
}

function reply() {
  const reply: any = {};
  reply.statusCode = 200;
  reply.payload = undefined;
  reply.code = jest.fn((statusCode: number) => {
    reply.statusCode = statusCode;
    return reply;
  });
  reply.send = jest.fn((payload: unknown) => {
    reply.payload = payload;
    return reply;
  });

  return reply as any;
}

function successfulChannelPoint() {
  return lnrpc.ChannelPoint.create({
    fundingTxidBytes: stringToUint8Array("abcdef"),
    outputIndex: 0,
  });
}

async function seedUnclaimed(
  db: Awaited<ReturnType<typeof getDb>>,
  {
    pubkey = PUBKEY,
    channelId = "claim-channel-1",
    amountSat = 5000,
    incomingChannelId = 1,
    htlcId = 1,
  } = {},
) {
  await createChannelRequest(db, {
    channelId,
    pubkey,
    preimage: `preimage-${channelId}`,
    status: "REGISTERED",
    start: 0,
    expire: 600,
    expectedAmountSat: amountSat,
    channelPoint: null,
  });
  await createHtlcSettlement(db, {
    channelId,
    incomingChannelId,
    htlcId,
    amountSat,
    settled: 1,
    claimed: 0,
  });
}

describe("/ondemand-channel/claim", () => {
  beforeEach(() => {
    (openChannelSync as jest.Mock).mockReset();
    (openChannelSync as jest.Mock).mockResolvedValue(successfulChannelPoint());
    __setListChannelsResponse({ channels: [] });
    __setPendingChannelsResponse({ pendingOpenChannels: [] });
  });

  test("does not open duplicate channels for concurrent claims by the same pubkey", async () => {
    const db = await getDb(true);
    await seedUnclaimed(db);
    const handler = Claim(db, {} as any);
    let resolveOpen: (value: lnrpc.ChannelPoint) => void = () => {};
    (openChannelSync as jest.Mock).mockImplementationOnce(() => {
      return new Promise<lnrpc.ChannelPoint>((resolve) => {
        resolveOpen = resolve;
      });
    });

    const firstReply = reply();
    const firstClaim = (handler as any)(claimRequest(), firstReply);
    await waitForExpect(() => {
      expect(openChannelSync).toBeCalledTimes(1);
    });

    const secondReply = reply();
    await (handler as any)(claimRequest(), secondReply);

    expect(openChannelSync).toBeCalledTimes(1);
    expect(firstReply.payload).toEqual({ status: "OK", amountSat: 5000 });
    expect(secondReply.payload).toEqual({ status: "OK", amountSat: 5000 });

    resolveOpen(successfulChannelPoint());
    await firstClaim;

    await expect(getChannelRequestUnclaimedAmount(db, PUBKEY)).resolves.toBe(0);
  });

  test("shares the same reservation across automatic and claim opening paths", async () => {
    const db = await getDb(true);
    await seedUnclaimed(db);
    let resolveOpen: (value: lnrpc.ChannelPoint) => void = () => {};
    (openChannelSync as jest.Mock).mockImplementationOnce(() => {
      return new Promise<lnrpc.ChannelPoint>((resolve) => {
        resolveOpen = resolve;
      });
    });

    const automaticOpen = openChannelForSettledHtlcs({
      db,
      lightning: {} as any,
      pubkey: PUBKEY,
      source: "AUTOMATIC",
      requestedChannelId: "claim-channel-1",
      requiredAmountSat: 5000,
      spendUnconfirmed: false,
      zeroConf: true,
      taprootChannel: true,
    });
    await waitForExpect(() => expect(openChannelSync).toBeCalledTimes(1));

    const claimResult = await openChannelForSettledHtlcs({
      db,
      lightning: {} as any,
      pubkey: PUBKEY,
      source: "CLAIM",
      spendUnconfirmed: true,
      zeroConf: true,
      taprootChannel: true,
    });

    expect(claimResult.status).toBe("IN_PROGRESS");
    expect(openChannelSync).toBeCalledTimes(1);

    resolveOpen(successfulChannelPoint());
    await expect(automaticOpen).resolves.toMatchObject({ status: "OPENED" });
  });

  test("recovers a second automatic request after the first opening completes", async () => {
    const db = await getDb(true);
    await seedUnclaimed(db, { channelId: "automatic-channel-1" });
    await seedUnclaimed(db, {
      channelId: "automatic-channel-2",
      incomingChannelId: 2,
      htlcId: 2,
    });

    let resolveFirstOpen: (value: lnrpc.ChannelPoint) => void = () => {};
    (openChannelSync as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise<lnrpc.ChannelPoint>((resolve) => {
            resolveFirstOpen = resolve;
          }),
      )
      .mockResolvedValueOnce(
        lnrpc.ChannelPoint.create({
          fundingTxidStr: "second-funding-txid",
          outputIndex: 1,
        }),
      );

    const firstOpen = openChannelForSettledHtlcs({
      db,
      lightning: {} as any,
      pubkey: PUBKEY,
      source: "AUTOMATIC",
      requestedChannelId: "automatic-channel-1",
      requiredAmountSat: 5000,
      spendUnconfirmed: false,
      zeroConf: false,
      taprootChannel: false,
    });
    await waitForExpect(() => expect(openChannelSync).toBeCalledTimes(1));

    // A recovery pass while the first open is unresolved must not start the
    // second open or reserve its settlements.
    await recoverChannelOpenState(db, {} as any);
    expect(openChannelSync).toBeCalledTimes(1);

    resolveFirstOpen(successfulChannelPoint());
    await expect(firstOpen).resolves.toMatchObject({ status: "OPENED" });

    // The next pass derives the queued request from SQLite and opens it.
    await recoverChannelOpenState(db, {} as any);
    expect(openChannelSync).toBeCalledTimes(2);
    await expect(getChannelRequestUnclaimedAmount(db, PUBKEY)).resolves.toBe(0);
    await expect(
      db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM channelOpenAttempt WHERE pubkey = ? AND status = 'OPENED'",
        PUBKEY,
      ),
    ).resolves.toEqual({ count: 2 });
  });

  test("does not automatically open historical unclaimed requests after migration", async () => {
    const db = await getDb(true);
    await seedUnclaimed(db, { channelId: "historical-channel" });
    await db.run(
      "UPDATE channelRequest SET automaticOpenQueued = 0 WHERE channelId = ?",
      "historical-channel",
    );

    await recoverChannelOpenState(db, {} as any);

    expect(openChannelSync).not.toBeCalled();
    await expect(getChannelRequestUnclaimedAmount(db, PUBKEY)).resolves.toBe(5000);
  });

  test("deducts the persisted fee quote from a claim payout", async () => {
    const db = await getDb(true);
    await seedUnclaimed(db);
    const handler = Claim(db, {} as any);

    await (handler as any)(claimRequest(), reply());

    expect(openChannelSync).toBeCalledTimes(1);
    const openCall = (openChannelSync as jest.Mock).mock.calls[0];
    expect(openCall[3].toString()).toBe("4990");

    const attempt = await db.get<{
      attemptId: string;
      grossAmountSat: number;
      feeSat: number;
      pushAmountSat: number;
    }>("SELECT attemptId, grossAmountSat, feeSat, pushAmountSat FROM channelOpenAttempt");
    expect(attempt).toMatchObject({
      grossAmountSat: 5000,
      feeSat: 10,
      pushAmountSat: 4990,
    });
    expect(openCall[8]).toBe(getChannelOpenAttemptMemo(attempt!.attemptId));
  });

  test("claims only the settlements reserved before the channel open", async () => {
    const db = await getDb(true);
    await seedUnclaimed(db);
    const handler = Claim(db, {} as any);
    let resolveOpen: (value: lnrpc.ChannelPoint) => void = () => {};
    (openChannelSync as jest.Mock).mockImplementationOnce(() => {
      return new Promise<lnrpc.ChannelPoint>((resolve) => {
        resolveOpen = resolve;
      });
    });

    const claim = (handler as any)(claimRequest(), reply());
    await waitForExpect(() => expect(openChannelSync).toBeCalledTimes(1));

    await seedUnclaimed(db, {
      channelId: "claim-channel-2",
      amountSat: 2000,
      incomingChannelId: 2,
      htlcId: 2,
    });
    resolveOpen(successfulChannelPoint());
    await claim;

    const first = await getHtlcSettlement(db, "claim-channel-1", 1, 1);
    const second = await getHtlcSettlement(db, "claim-channel-2", 2, 2);
    expect(first?.claimed).toBe(1);
    expect(first?.channelOpenAttemptId).toBeTruthy();
    expect(second?.claimed).toBe(0);
    expect(second?.channelOpenAttemptId).toBeNull();
    await expect(getChannelRequestUnclaimedAmount(db, PUBKEY)).resolves.toBe(2000);
  });

  test("keeps an ambiguous open reserved and never retries it blindly", async () => {
    const db = await getDb(true);
    await seedUnclaimed(db);
    const handler = Claim(db, {} as any);
    (openChannelSync as jest.Mock).mockRejectedValueOnce(new Error("transport lost"));

    const firstReply = reply();
    await (handler as any)(claimRequest(), firstReply);

    const attempt = await getActiveChannelOpenAttempt(db, PUBKEY);
    expect(attempt?.status).toBe("UNKNOWN");
    expect(attempt?.error).toBe("transport lost");
    const settlement = await getHtlcSettlement(db, "claim-channel-1", 1, 1);
    expect(settlement?.claimed).toBe(0);
    expect(settlement?.channelOpenAttemptId).toBe(attempt?.attemptId);

    const secondReply = reply();
    await (handler as any)(claimRequest(), secondReply);

    expect(openChannelSync).toBeCalledTimes(1);
    expect(firstReply.payload).toEqual({ status: "OK", amountSat: 5000 });
    expect(secondReply.payload).toEqual({ status: "OK", amountSat: 5000 });
  });

  test("reconciles an ambiguous open by its exact lnd memo", async () => {
    const db = await getDb(true);
    await seedUnclaimed(db);
    const handler = Claim(db, {} as any);
    (openChannelSync as jest.Mock).mockRejectedValueOnce(new Error("transport lost"));

    await (handler as any)(claimRequest(), reply());
    const attempt = await getActiveChannelOpenAttempt(db, PUBKEY);
    expect(attempt).toBeDefined();

    __setPendingChannelsResponse({
      pendingOpenChannels: [
        {
          channel: {
            remoteNodePub: PUBKEY,
            channelPoint: "unrelated-txid:0",
            memo: "some-other-channel-open",
          },
        },
      ],
    });
    await (handler as any)(claimRequest(), reply());
    expect((await getHtlcSettlement(db, "claim-channel-1", 1, 1))?.claimed).toBe(0);

    __setPendingChannelsResponse({
      pendingOpenChannels: [
        {
          channel: {
            remoteNodePub: PUBKEY,
            channelPoint: "reconciled-txid:0",
            memo: getChannelOpenAttemptMemo(attempt!.attemptId),
          },
        },
      ],
    });

    await recoverChannelOpenState(db, {} as any);

    expect(openChannelSync).toBeCalledTimes(1);
    await expect(getActiveChannelOpenAttempt(db, PUBKEY)).resolves.toBeUndefined();
    const settlement = await getHtlcSettlement(db, "claim-channel-1", 1, 1);
    expect(settlement?.claimed).toBe(1);
  });
});
