import Long from "long";
import waitForExpect from "wait-for-expect";
import { DuplexMock, BufferWritableMock } from "stream-mock";

import { routerrpc } from "../../../../src/proto";
import { IRegisterOkResponse } from "../../../../src/services/ondemand-channel/api/register";
import build from "../../../../src/app";
import { bytesToHexString, sha256Buffer, timeout } from "../../../../src/utils/common";

// Mocked functions
import { openChannelSync } from "../../../../mocks/utils/lnd-api";
import { createForwardHtlcInterceptRequest, sendRegisterRequest, createPreimage } from "./register-helpers";

describe("/ondemand-channel/register", () => {
  test("registers and opens a channel when the HTLC are settled (non-MPP)", async () => {
    const app = build();

    const amountSat = 20000;
    const preimage = createPreimage(0);
    const paymentHash = sha256Buffer(preimage);
    const pubkey = "abcdef12345";
    const signature = "validsig";
    const incomingChanId = Long.fromValue(1);
    const htlcPart = Long.fromValue(123);

    const response = await sendRegisterRequest(app, {
      amountSat,
      preimage: bytesToHexString(preimage),
      pubkey,
      signature,
    });
    expect(response.statusCode).toBe(200);
    const registerResponse = response.json() as IRegisterOkResponse;

    const htlcInterceptorStream: DuplexMock = require("../../../../src/utils/lnd-api")
      .__htlcInterceptorStream;
    htlcInterceptorStream.emit(
      "data",
      createForwardHtlcInterceptRequest(
        amountSat,
        registerResponse.fakeChannelId,
        paymentHash,
        incomingChanId,
        htlcPart,
      ),
    );
    let forwardHtlcInterceptResponse: routerrpc.ForwardHtlcInterceptResponse | null = null;
    // Replace the write function so we can spy on the response
    htlcInterceptorStream.write = (data: any) => {
      const r = routerrpc.ForwardHtlcInterceptResponse.decode(data);
      if (r.incomingCircuitKey?.chanId?.eq(incomingChanId)) {
        forwardHtlcInterceptResponse = r;
      }
      return true;
    };

    await timeout(500);

    const subscribeHtlcEventsStream: BufferWritableMock = require("../../../../src/utils/lnd-api")
      .__subscribeHtlcEventsStream;
    subscribeHtlcEventsStream.emit(
      "data",
      routerrpc.HtlcEvent.encode({
        eventType: routerrpc.HtlcEvent.EventType.FORWARD,
        finalHtlcEvent: { settled: true, offchain: true },
        incomingChannelId: incomingChanId,
        incomingHtlcId: htlcPart,
        outgoingChannelId: Long.fromValue(registerResponse.fakeChannelId),
      }).finish(),
    );

    await waitForExpect(async () => {
      expect(forwardHtlcInterceptResponse?.action).toBe(routerrpc.ResolveHoldForwardAction.SETTLE);
      expect(openChannelSync).toBeCalled();
    });

    await timeout(500);

    app.close();
  });

  test("waits for lnd's final outcome, not the settle event, before paying out", async () => {
    (openChannelSync as jest.Mock).mockClear();
    const app = build();

    const amountSat = 20000;
    const preimage = createPreimage(7);
    const incomingChanId = Long.fromValue(7);
    const htlcPart = Long.fromValue(77);
    const response = await sendRegisterRequest(app, {
      amountSat,
      preimage: bytesToHexString(preimage),
      pubkey: "abcdef12345",
      signature: "validsig",
    });
    const registerResponse = response.json() as IRegisterOkResponse;

    const htlcInterceptorStream: DuplexMock = require("../../../../src/utils/lnd-api")
      .__htlcInterceptorStream;
    let action: routerrpc.ResolveHoldForwardAction | null = null;
    htlcInterceptorStream.write = (data: any) => {
      const r = routerrpc.ForwardHtlcInterceptResponse.decode(data);
      if (r.incomingCircuitKey?.chanId?.eq(incomingChanId)) {
        action = r.action;
      }
      return true;
    };
    htlcInterceptorStream.emit(
      "data",
      createForwardHtlcInterceptRequest(
        amountSat,
        registerResponse.fakeChannelId,
        sha256Buffer(preimage),
        incomingChanId,
        htlcPart,
      ),
    );
    await waitForExpect(() => expect(action).toBe(routerrpc.ResolveHoldForwardAction.SETTLE));

    const htlcEvents: BufferWritableMock = require("../../../../src/utils/lnd-api")
      .__subscribeHtlcEventsStream;
    const event = (fields: Partial<routerrpc.IHtlcEvent>) =>
      htlcEvents.emit(
        "data",
        routerrpc.HtlcEvent.encode({
          eventType: routerrpc.HtlcEvent.EventType.FORWARD,
          incomingChannelId: incomingChanId,
          incomingHtlcId: htlcPart,
          outgoingChannelId: Long.fromValue(registerResponse.fakeChannelId),
          ...fields,
        }).finish(),
      );

    // lnd has sent the preimage, but the payer hasn't locked the settlement in.
    event({ settleEvent: {} });
    await timeout(500);
    expect(openChannelSync).not.toHaveBeenCalled();

    event({ finalHtlcEvent: { settled: true, offchain: true } });
    await waitForExpect(() => expect(openChannelSync).toHaveBeenCalled());

    await app.close();
  });
});
