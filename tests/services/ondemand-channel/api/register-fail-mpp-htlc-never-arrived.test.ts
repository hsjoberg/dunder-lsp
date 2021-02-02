import Long from "long";
import waitForExpect from "wait-for-expect";
import { DuplexMock } from "stream-mock";

import { routerrpc } from "../../../../src/proto";
import { IRegisterOkResponse } from "../../../../src/services/ondemand-channel/api/register";
import build from "../../../../src/app";
import { bytesToHexString, sha256Buffer, timeout } from "../../../../src/utils/common";
import { createForwardHtlcInterceptRequest, sendRegisterRequest } from "./register-helpers";

jest.setTimeout(70 * 1000);

// Mocked functions
import { openChannelSync } from "../../../../mocks/utils/lnd-api";

describe("/ondemand-channel/register", () => {
  it("should fail HTLC that has a part that never arrived", async (done) => {
    const app = build();

    const amountSat = 20000;
    const preimage = new Uint8Array([0]);
    const paymentHash = sha256Buffer(preimage);
    const pubkey = "abcdef12345";
    const signature = "validsig";
    const htlcPart = Long.fromValue(123);
    const htlcPart2 = Long.fromValue(456);

    const response = await sendRegisterRequest(app, {
      amount: amountSat,
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
        htlcPart,
      ),
    );

    await waitForExpect(async () => {
      expect(forwardHtlcInterceptResponse?.[0].action).toBe(
        routerrpc.ResolveHoldForwardAction.FAIL,
      );
      expect(openChannelSync).not.toBeCalled();
    }, 60 * 1000);

    await timeout(500);

    app.close();
    done();
  });
});
