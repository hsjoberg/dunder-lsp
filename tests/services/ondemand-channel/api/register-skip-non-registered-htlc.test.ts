import Long from "long";
import waitForExpect from "wait-for-expect";
import { DuplexMock, BufferWritableMock } from "stream-mock";

import { routerrpc } from "../../../../src/proto";
import build from "../../../../src/app";
import { timeout } from "../../../../src/utils/common";
import { createForwardHtlcInterceptRequest } from "./register-helpers";

describe("/ondemand-channel/register", () => {
  it("should skip settling HTLCs that are not registered for service", async (done) => {
    const app = build();
    await app.inject({
      url: "/",
      method: "GET",
    });

    // Emit a HtlcInterception event that is not registered to a faked channel
    // and thus not applicable for service.
    const htlcInterceptorStream: DuplexMock = require("../../../../mocks/utils/lnd-api")
      .__htlcInterceptorStream;
    let forwardHtlcInterceptResponse: routerrpc.ForwardHtlcInterceptResponse | null = null;
    // Replace the write function so we can spy on the response
    htlcInterceptorStream.write = (data: any) => {
      forwardHtlcInterceptResponse = routerrpc.ForwardHtlcInterceptResponse.decode(data);
      return true;
    };
    htlcInterceptorStream.emit(
      "data",
      createForwardHtlcInterceptRequest(
        12345,
        "12345689",
        new Uint8Array([1, 2, 3]),
        Long.fromValue(9),
      ),
    );

    await timeout(1000);

    await waitForExpect(() => {
      expect(forwardHtlcInterceptResponse?.action).toBe(routerrpc.ResolveHoldForwardAction.RESUME);
    });

    app.close();
    done();
  });
});
