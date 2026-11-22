import getDb from "../../../../src/db/db";
import {
  createChannelRequest,
  createHtlcSettlement,
} from "../../../../src/db/ondemand-channel";
import { lnrpc } from "../../../../src/proto";
import {
  AUTO_HEAL_MIN_INTERVAL_MS,
  openAutoHealChannelIfNeeded,
} from "../../../../src/services/ondemand-channel/api/misc/auto-heal";
import { stringToUint8Array } from "../../../../src/utils/common";
import {
  __listChannels,
  __pendingChannels,
  __setListChannelsResponse,
  __setPendingChannelsResponse,
  checkPeerConnected,
  openChannelSync,
} from "../../../../mocks/utils/lnd-api";

const PUBKEY = "abcdef12345";

describe("auto-heal", () => {
  beforeEach(() => {
    __listChannels.mockClear();
    __pendingChannels.mockClear();
    (checkPeerConnected as jest.Mock).mockClear();
    (openChannelSync as jest.Mock).mockReset();
    (openChannelSync as jest.Mock).mockResolvedValue(
      lnrpc.ChannelPoint.create({
        fundingTxidBytes: stringToUint8Array("abcdef"),
        outputIndex: 0,
      }),
    );
    __setListChannelsResponse({ channels: [] });
    __setPendingChannelsResponse({ pendingOpenChannels: [] });
  });

  test("does not call lnd when the peer has no unclaimed settlements", async () => {
    const db = await getDb(true);

    await expect(openAutoHealChannelIfNeeded(db, {} as any, PUBKEY)).resolves.toBeUndefined();

    expect(checkPeerConnected).not.toBeCalled();
    expect(__listChannels).not.toBeCalled();
    expect(__pendingChannels).not.toBeCalled();
    expect(openChannelSync).not.toBeCalled();
  });

  test("opens a configured Taproot zero-conf channel for a claimable settlement", async () => {
    const db = await getDb(true);
    await createChannelRequest(db, {
      channelId: "auto-heal-channel",
      pubkey: PUBKEY,
      preimage: "auto-heal-preimage",
      status: "REGISTERED",
      start: 0,
      expire: 600,
      expectedAmountSat: 5000,
      channelPoint: null,
    });
    await createHtlcSettlement(db, {
      channelId: "auto-heal-channel",
      incomingChannelId: "1",
      htlcId: "1",
      amountSat: 5000,
      settled: 1,
      claimed: 0,
    });

    await expect(
      openAutoHealChannelIfNeeded(db, {} as any, PUBKEY),
    ).resolves.toMatchObject({ status: "OPENED" });

    expect(openChannelSync).toBeCalledTimes(1);
    expect((openChannelSync as jest.Mock).mock.calls[0][5]).toBe(true);
    expect((openChannelSync as jest.Mock).mock.calls[0][6]).toBe(true);
  });

  test("runs at most once per interval for a wallet whose payout stays blocked", async () => {
    const db = await getDb(true);
    const pubkey = "auto-heal-blocked";
    await createChannelRequest(db, {
      channelId: "auto-heal-blocked-channel",
      pubkey,
      preimage: "auto-heal-blocked-preimage",
      status: "REGISTERED",
      start: 0,
      expire: 600,
      expectedAmountSat: 5000,
      channelPoint: null,
    });
    await createHtlcSettlement(db, {
      channelId: "auto-heal-blocked-channel",
      incomingChannelId: "2",
      htlcId: "1",
      amountSat: 5000,
      settled: 1,
      claimed: 0,
    });
    // The wallet keeps a channel of its own pending, which blocks the payout.
    __setPendingChannelsResponse({
      pendingOpenChannels: [{ channel: { remoteNodePub: pubkey, channelPoint: "dd:0" } }],
    });

    const start = 1_000_000;
    await openAutoHealChannelIfNeeded(db, {} as any, pubkey, start);
    expect(__pendingChannels).toBeCalled();
    expect(openChannelSync).not.toBeCalled();

    __pendingChannels.mockClear();
    for (let i = 1; i <= 5; i++) {
      await expect(
        openAutoHealChannelIfNeeded(db, {} as any, pubkey, start + i * 1000),
      ).resolves.toBeUndefined();
    }
    expect(__pendingChannels).not.toBeCalled();

    await openAutoHealChannelIfNeeded(db, {} as any, pubkey, start + AUTO_HEAL_MIN_INTERVAL_MS);
    expect(__pendingChannels).toBeCalled();
  });
});
