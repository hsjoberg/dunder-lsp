import build from "../../../../src/app";
import { bytesToHexString } from "../../../../src/utils/common";

// Mocked functions
import { checkPeerConnected } from "../../../../mocks/utils/lnd-api";
import { sendRegisterRequest } from "./register-helpers";

describe("/ondemand-channel/register", () => {
  it("should fail on erroneous signature", async (done) => {
    const app = build();
    require("../../../../src/utils/lnd-api").__verifyMessageSetValidSig(false);
    const amountSat = 10000;
    const preimage = new Uint8Array([1, 2, 3, 4]);
    const pubkey = "abcdef12345";
    const signature = "badsig";

    const response = await sendRegisterRequest(app, {
      amountSat,
      preimage: bytesToHexString(preimage),
      pubkey,
      signature,
    });
    expect(response.statusCode).toBe(400);
    require("../../../../src/utils/lnd-api").__verifyMessageSetValidSig(true);
    app.close();
    done();
  });

  test("fails if wallet node in not connected to the service", async (done) => {
    const app = build();
    const amountSat = 10000;
    const preimage = new Uint8Array([3]);
    const pubkey = "abcdef12345";
    const signature = "validsig";

    checkPeerConnected.mockImplementationOnce(() => {
      return false;
    });

    const response = await sendRegisterRequest(app, {
      amountSat,
      preimage: bytesToHexString(preimage),
      pubkey,
      signature,
    });
    expect(response.statusCode).toBe(400);
    app.close();
    done();
  });
});
