import waitForExpect from "wait-for-expect";

import Claim from "../../../../src/services/ondemand-channel/api/claim";
import getDb from "../../../../src/db/db";
import {
  createChannelRequest,
  createHtlcSettlement,
  getChannelRequestUnclaimedAmount,
} from "../../../../src/db/ondemand-channel";
import { clearClaimChannelOpenLocksForTests } from "../../../../src/services/ondemand-channel/api/claim-channel-open-lock";
import { lnrpc } from "../../../../src/proto";
import { stringToUint8Array } from "../../../../src/utils/common";

import { openChannelSync } from "../../../../mocks/utils/lnd-api";

function claimRequest(pubkey = "abcdef12345") {
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

async function seedUnclaimed(db: Awaited<ReturnType<typeof getDb>>, pubkey = "abcdef12345") {
  await createChannelRequest(db, {
    channelId: "claim-channel-1",
    pubkey,
    preimage: "claim-preimage-1",
    status: "REGISTERED",
    start: 0,
    expire: 600,
    expectedAmountSat: 5000,
    channelPoint: null,
  });
  await createHtlcSettlement(db, {
    channelId: "claim-channel-1",
    incomingChannelId: 1,
    htlcId: 1,
    amountSat: 5000,
    settled: 1,
    claimed: 0,
  });
}

describe("/ondemand-channel/claim", () => {
  beforeEach(() => {
    clearClaimChannelOpenLocksForTests();
    openChannelSync.mockReset();
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

    resolveOpen(
      lnrpc.ChannelPoint.create({
        fundingTxidBytes: stringToUint8Array("abcdef"),
        outputIndex: 0,
      }),
    );
    await firstClaim;

    await expect(getChannelRequestUnclaimedAmount(db, "abcdef12345")).resolves.toBe(0);
  });
});
