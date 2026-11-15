import Long from "long";
import waitForExpect from "wait-for-expect";
import { DuplexMock, BufferWritableMock } from "stream-mock";

import { routerrpc } from "../../../../src/proto";
import { IRegisterOkResponse } from "../../../../src/services/ondemand-channel/api/register";
import build from "../../../../src/app";
import { bytesToHexString, sha256Buffer, timeout } from "../../../../src/utils/common";
import { createForwardHtlcInterceptRequest, sendRegisterRequest, createPreimage } from "./register-helpers";

jest.setTimeout(20 * 1000);

// Mocked functions
import { openChannelSync } from "../../../../mocks/utils/lnd-api";

describe("/ondemand-channel/register", () => {
  it("never fails a part after settling it, and waits for every settle event", async () => {
    const app = build();

    const amountSat = 20000;
    const preimage = createPreimage(0);
    const paymentHash = sha256Buffer(preimage);
    const pubkey = "abcdef12345";
    const signature = "validsig";
    const incomingChanId = Long.fromValue(1);
    const htlcPart = Long.fromValue(123);
    const incomingChanId2 = Long.fromValue(2);
    const htlcPart2 = Long.fromValue(456);

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
    let forwardHtlcInterceptResponse: routerrpc.ForwardHtlcInterceptResponse[] | null = [];
    let it = 0;
    // Replace the write function so we can spy on the response
    htlcInterceptorStream.write = (data: any) => {
      const r = routerrpc.ForwardHtlcInterceptResponse.decode(data);
      // Simulate loss of the second write
      if (it++ != 1) {
        forwardHtlcInterceptResponse?.push(r);
      }
      return true;
    };

    htlcInterceptorStream.emit(
      "data",
      createForwardHtlcInterceptRequest(
        amountSat / 2,
        registerResponse.fakeChannelId,
        paymentHash,
        incomingChanId,
        htlcPart,
      ),
    );
    await timeout(1000);
    htlcInterceptorStream.emit(
      "data",
      createForwardHtlcInterceptRequest(
        amountSat / 2,
        registerResponse.fakeChannelId,
        paymentHash,
        incomingChanId2,
        htlcPart2,
      ),
    );

    await timeout(1000);

    const subscribeHtlcEventsStream: BufferWritableMock = require("../../../../src/utils/lnd-api")
      .__subscribeHtlcEventsStream;
    subscribeHtlcEventsStream.emit(
      "data",
      routerrpc.HtlcEvent.encode({
        eventType: routerrpc.HtlcEvent.EventType.FORWARD,
        settleEvent: {},
        incomingChannelId: incomingChanId,
        incomingHtlcId: htlcPart,
        outgoingChannelId: Long.fromValue(registerResponse.fakeChannelId),
      }).finish(),
    );

    await waitForExpect(async () => {
      expect(forwardHtlcInterceptResponse?.[0].action).toBe(
        routerrpc.ResolveHoldForwardAction.SETTLE,
      );
    }, 20 * 1000);

    // Once SETTLE has been sent, the parts must never be failed as well: lnd
    // drops the interceptor stream when a circuit is answered twice. The
    // channel isn't opened until every part is confirmed settled.
    await timeout(6000);
    expect(forwardHtlcInterceptResponse).toHaveLength(1);
    expect(openChannelSync).not.toBeCalled();

    // TODO(hsjoberg): check if information got correctly stored in db

    await timeout(500);

    app.close();
  });
});
