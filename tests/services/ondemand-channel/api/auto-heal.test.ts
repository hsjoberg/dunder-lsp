import getDb from "../../../../src/db/db";
import {
  createChannelRequest,
  createHtlcSettlement,
} from "../../../../src/db/ondemand-channel";
import { lnrpc } from "../../../../src/proto";
import { openAutoHealChannelIfNeeded } from "../../../../src/services/ondemand-channel/api/misc/auto-heal";
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
      incomingChannelId: 1,
      htlcId: 1,
      amountSat: 5000,
      settled: 1,
      claimed: 0,
    });

    await expect(
      openAutoHealChannelIfNeeded(db, {} as any, PUBKEY),
    ).resolves.toMatchObject({ status: "OPENED" });

    expect(openChannelSync).toBeCalledTimes(1);
    expect((openChannelSync as jest.Mock).mock.calls[0][6]).toBe(true);
    expect((openChannelSync as jest.Mock).mock.calls[0][7]).toBe(true);
  });
});
