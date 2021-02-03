import Long from "long";
import waitForExpect from "wait-for-expect";
import { DuplexMock, BufferWritableMock } from "stream-mock";

import { routerrpc } from "../../../../src/proto";
import { IRegisterOkResponse } from "../../../../src/services/ondemand-channel/api/register";
import build from "../../../../src/app";
import { bytesToHexString, sha256Buffer, timeout } from "../../../../src/utils/common";
import { createForwardHtlcInterceptRequest, sendRegisterRequest } from "./register-helpers";

// Mocked functions
import { openChannelSync, checkPeerConnected } from "../../../../mocks/utils/lnd-api";

describe("/ondemand-channel/register", () => {
  it("should fail HTLC if wallet has lost connection to the LSP (after registration)", async (done) => {
    openChannelSync.mockClear();
    const app = build();

    // Simulate connection lost mid-part
    checkPeerConnected.mockImplementationOnce(() => {
      return true;
    });
    checkPeerConnected.mockImplementationOnce(() => {
      return false;
    });

    const amountSat = 10000;
    const preimage = new Uint8Array([5]);
    const paymentHash = sha256Buffer(preimage);
    const pubkey = "abcdef12345";
    const signature = "validsig";
    const htlcPart = Long.fromValue(1234);

    const response = await sendRegisterRequest(app, {
      amountSat,
      preimage: bytesToHexString(preimage),
      pubkey,
      signature,
    });
    console.log(response.body);
    expect(response.statusCode).toBe(200);
    const registerResponse = response.json() as IRegisterOkResponse;

    const htlcInterceptorStream: DuplexMock = require("../../../../src/utils/lnd-api")
      .__htlcInterceptorStream;
    let forwardHtlcInterceptResponse: routerrpc.ForwardHtlcInterceptResponse | null = null;
    // Replace the write function so we can spy on the response
    const oldWrite = htlcInterceptorStream.write;
    htlcInterceptorStream.write = (data: any) => {
      const r = routerrpc.ForwardHtlcInterceptResponse.decode(data);
      if (r.incomingCircuitKey?.chanId?.eq(registerResponse.fakeChannelId)) {
        forwardHtlcInterceptResponse = r;
      } else {
        console.error("FAIL");
      }
      return true;
    };
    htlcInterceptorStream.emit(
      "data",
      createForwardHtlcInterceptRequest(
        amountSat,
        registerResponse.fakeChannelId,
        paymentHash,
        htlcPart,
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
        outgoingChannelId: Long.fromValue(registerResponse.fakeChannelId),
        incomingHtlcId: htlcPart,
      }).finish(),
    );

    await waitForExpect(async () => {
      expect(forwardHtlcInterceptResponse?.action).toBe(routerrpc.ResolveHoldForwardAction.FAIL);
      expect(openChannelSync).not.toBeCalled();
    });

    await timeout(500);
    htlcInterceptorStream.write = oldWrite;
    app.close();
    done();
  });
});
