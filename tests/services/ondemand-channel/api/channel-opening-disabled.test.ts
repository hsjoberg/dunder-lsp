import Long from "long";
import waitForExpect from "wait-for-expect";
import { DuplexMock } from "stream-mock";

import build from "../../../../src/app";
import getDb from "../../../../src/db/db";
import {
  createChannelRequest,
  createHtlcSettlement,
  getChannelRequestUnclaimedAmount,
  getHtlcSettlements,
} from "../../../../src/db/ondemand-channel";
import { getActiveChannelOpenAttempt } from "../../../../src/db/channel-open-attempt";
import { routerrpc } from "../../../../src/proto";
import * as onDemandUtils from "../../../../src/services/ondemand-channel/api/utils";
import { openAutoHealChannelIfNeeded } from "../../../../src/services/ondemand-channel/api/misc/auto-heal";
import { IRegisterOkResponse } from "../../../../src/services/ondemand-channel/api/register";
import {
  openChannelForSettledHtlcs,
  recoverChannelOpenState,
} from "../../../../src/services/ondemand-channel/channel-open";
import { bytesToHexString, sha256Buffer, timeout } from "../../../../src/utils/common";
import { checkPeerConnected, openChannelSync } from "../../../../mocks/utils/lnd-api";
import {
  createForwardHtlcInterceptRequest,
  createPreimage,
  sendRegisterRequest,
} from "./register-helpers";
import { createOnDemandChannelHtlcHandler } from "../../../../src/services/ondemand-channel/api/register";

const PUBKEY = "abcdef12345";

async function createSettledRequest(channelId: string) {
  const db = await getDb(true);
  await createChannelRequest(db, {
    channelId,
    pubkey: PUBKEY,
    preimage: `${channelId}-preimage`,
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
    settled: 1,
    claimed: 0,
  });
  return db;
}

describe("channelOpeningEnabled = false", () => {
  let enabledSpy: jest.SpyInstance;

  beforeEach(() => {
    (openChannelSync as jest.Mock).mockClear();
    (checkPeerConnected as jest.Mock).mockClear();
    enabledSpy = jest.spyOn(onDemandUtils, "isChannelOpeningEnabled").mockReturnValue(false);
  });

  afterEach(() => {
    enabledSpy.mockRestore();
  });

  test("/register refuses new channel requests", async () => {
    const app = build();

    const response = await sendRegisterRequest(app, {
      amountSat: 20000,
      preimage: bytesToHexString(createPreimage(1)),
      pubkey: PUBKEY,
      signature: "validsig",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "ERROR" });
    await app.close();
  });

  test("/claim refuses to open a channel", async () => {
    const app = build();

    const response = await app.inject({
      url: "/ondemand-channel/claim",
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      payload: JSON.stringify({ pubkey: PUBKEY, signature: "validsig" }),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "ERROR" });
    expect(openChannelSync).not.toBeCalled();
    await app.close();
  });

  test("/service-status reports the service as unavailable", async () => {
    const app = build();

    const response = await app.inject({
      url: "/ondemand-channel/service-status",
      method: "GET",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: false });
    await app.close();
  });

  test("fails, rather than settles, an HTLC for an existing channel request", async () => {
    // Register while opening is still enabled, then disable it before the
    // payment arrives.
    enabledSpy.mockReturnValue(true);
    const app = build();
    const amountSat = 20000;
    const preimage = createPreimage(7);
    const incomingChanId = Long.fromValue(77);
    const htlcPart = Long.fromValue(1);

    const response = await sendRegisterRequest(app, {
      amountSat,
      preimage: bytesToHexString(preimage),
      pubkey: PUBKEY,
      signature: "validsig",
    });
    expect(response.statusCode).toBe(200);
    const { fakeChannelId } = response.json() as IRegisterOkResponse;

    enabledSpy.mockReturnValue(false);

    const htlcInterceptorStream: DuplexMock = require("../../../../mocks/utils/lnd-api")
      .__htlcInterceptorStream;
    let forwardHtlcInterceptResponse: routerrpc.ForwardHtlcInterceptResponse | null = null;
    htlcInterceptorStream.write = (data: any) => {
      const r = routerrpc.ForwardHtlcInterceptResponse.decode(data);
      if (r.incomingCircuitKey?.chanId?.eq(incomingChanId)) {
        forwardHtlcInterceptResponse = r;
      }
      return true;
    };
    htlcInterceptorStream.emit(
      "data",
      createForwardHtlcInterceptRequest(
        amountSat,
        fakeChannelId,
        sha256Buffer(preimage),
        incomingChanId,
        htlcPart,
      ),
    );

    await waitForExpect(() => {
      expect(forwardHtlcInterceptResponse?.action).toBe(routerrpc.ResolveHoldForwardAction.FAIL);
    });
    await timeout(100);
    expect(await getHtlcSettlements(await getDb(), fakeChannelId)).toHaveLength(0);
    expect(openChannelSync).not.toBeCalled();
    await app.close();
  });

  test("still settles an HTLC that was recorded for settlement before it was disabled", async () => {
    // Failing it could leave a payment partly settled: its other parts may
    // already be settled.
    const db = await getDb(true);
    const preimage = createPreimage(9);
    await createChannelRequest(db, {
      channelId: "4242",
      pubkey: PUBKEY,
      preimage: bytesToHexString(preimage),
      status: "REGISTERED",
      start: Math.floor(Date.now() / 1000),
      expire: 600,
      expectedAmountSat: 20000,
      channelPoint: null,
    });
    await createHtlcSettlement(db, {
      channelId: "4242",
      incomingChannelId: "99",
      htlcId: "3",
      amountSat: 20000,
      settled: 0,
      claimed: 0,
    });
    const actions: routerrpc.ResolveHoldForwardAction[] = [];
    const handler = createOnDemandChannelHtlcHandler(db, {} as any);

    await handler(
      routerrpc.ForwardHtlcInterceptRequest.decode(
        createForwardHtlcInterceptRequest(
          20000,
          "4242",
          sha256Buffer(preimage),
          Long.fromValue(99),
          Long.fromValue(3),
        ),
      ),
      {
        responded: false,
        respond: (action) => {
          actions.push(action);
        },
      },
    );

    expect(actions).toEqual([routerrpc.ResolveHoldForwardAction.SETTLE]);
  });

  test("does not open a channel for settled HTLCs", async () => {
    const db = await createSettledRequest("disabled-open-channel");

    await expect(
      openChannelForSettledHtlcs({
        db,
        lightning: {} as any,
        pubkey: PUBKEY,
        source: "CLAIM",
        zeroConf: false,
        taprootChannel: false,
      }),
    ).resolves.toEqual({ status: "DISABLED" });

    expect(openChannelSync).not.toBeCalled();
    expect(await getActiveChannelOpenAttempt(db, PUBKEY)).toBeFalsy();
    expect(await getChannelRequestUnclaimedAmount(db, PUBKEY)).toBe(5000);
  });

  test("auto-heal and the recovery loop do not open channels", async () => {
    const db = await createSettledRequest("disabled-recovery-channel");

    await expect(openAutoHealChannelIfNeeded(db, {} as any, PUBKEY)).resolves.toBeUndefined();
    await expect(recoverChannelOpenState(db, {} as any)).resolves.toEqual([]);

    expect(checkPeerConnected).not.toBeCalled();
    expect(openChannelSync).not.toBeCalled();
    expect(await getChannelRequestUnclaimedAmount(db, PUBKEY)).toBe(5000);
  });
});
