import Long from "long";
import waitForExpect from "wait-for-expect";
import { DuplexMock, BufferWritableMock } from "stream-mock";

import { routerrpc } from "../../../../src/proto";
import { IRegisterOkResponse } from "../../../../src/services/ondemand-channel/api/register";
import build from "../../../../src/app";
import { bytesToHexString, sha256Buffer, timeout } from "../../../../src/utils/common";
import { createForwardHtlcInterceptRequest, sendRegisterRequest } from "./register-helpers";

// Mocked functions
import { openChannelSync } from "../../../../mocks/utils/lnd-api";

jest.setTimeout(20000);

describe("/ondemand-channel/register", () => {
  test("registers and opens a channel when the HTLCs are settled (MPP)", async (done) => {
    const app = build();

    const amountSat = 20000;
    const preimage = new Uint8Array([0]);
    const paymentHash = sha256Buffer(preimage);
    const pubkey = "abcdef12345";
    const signature = "validsig";
    const htlcPart = Long.fromValue(123);
    const incomingChanId = Long.fromValue(1);
    const htlcPart2 = Long.fromValue(456);
    const incomingChanId2 = Long.fromValue(2);

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
    // Replace the write function so we can spy on the response
    htlcInterceptorStream.write = (data: any) => {
      const r = routerrpc.ForwardHtlcInterceptResponse.decode(data);
      if (r.incomingCircuitKey?.chanId?.eq(registerResponse.fakeChannelId)) {
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

    await timeout(500);

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
    await timeout(100);
    subscribeHtlcEventsStream.emit(
      "data",
      routerrpc.HtlcEvent.encode({
        eventType: routerrpc.HtlcEvent.EventType.FORWARD,
        settleEvent: {},
        incomingChannelId: incomingChanId2,
        incomingHtlcId: htlcPart2,
        outgoingChannelId: Long.fromValue(registerResponse.fakeChannelId),
      }).finish(),
    );

    await waitForExpect(async () => {
      expect(
        forwardHtlcInterceptResponse?.every(
          (r) => r.action === routerrpc.ResolveHoldForwardAction.SETTLE,
        ),
      ).toBe(true);
      expect(openChannelSync).toBeCalled();
    });

    await timeout(500);

    app.close();
    done();
  });
});
