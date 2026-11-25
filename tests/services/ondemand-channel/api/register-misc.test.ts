import build from "../../../../src/app";
import * as common from "../../../../src/utils/common";
import { bytesToHexString } from "../../../../src/utils/common";

// Mocked functions
import { checkPeerConnected } from "../../../../mocks/utils/lnd-api";
import { sendRegisterRequest, createPreimage } from "./register-helpers";

describe("/ondemand-channel/register", () => {
  it("should fail on erroneous signature", async () => {
    const app = build();
    require("../../../../src/utils/lnd-api").__verifyMessageSetValidSig(false);
    const amountSat = 10000;
    const preimage = createPreimage(1, 2, 3, 4);
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
  });

  test("fails if wallet node in not connected to the service", async () => {
    const app = build();
    const amountSat = 10000;
    const preimage = createPreimage(3);
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
  });

  test("never hands out channel ID 0", async () => {
    const app = build();
    const generate = jest
      .spyOn(common, "generateShortChannelId")
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(12345);
    try {
      const response = await sendRegisterRequest(app, {
        amountSat: 10000,
        preimage: bytesToHexString(createPreimage(5, 0, 9)),
        pubkey: "abcdef12345",
        signature: "validsig",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().fakeChannelId).toBe("12345");
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      generate.mockRestore();
      app.close();
    }
  });

  test.each([
    ["a 1-byte preimage", { preimage: "00", amountSat: 10000 }],
    ["a 31-byte preimage", { preimage: "00".repeat(31), amountSat: 10000 }],
    ["a non-hex preimage", { preimage: "zz".repeat(32), amountSat: 10000 }],
    ["a fractional amount", { preimage: "01".repeat(32), amountSat: 10000.5 }],
    ["a zero amount", { preimage: "02".repeat(32), amountSat: 0 }],
    ["a string amount", { preimage: "03".repeat(32), amountSat: "10000" }],
  ])("rejects %s", async (_name, fields) => {
    const app = build();
    const response = await app.inject({
      url: "/ondemand-channel/register",
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      payload: JSON.stringify({ pubkey: "abcdef12345", signature: "validsig", ...fields }),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).status).toBe("ERROR");
    await app.close();
  });

  test("rejects a body that is not JSON", async () => {
    const app = build();
    const response = await app.inject({
      url: "/ondemand-channel/register",
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      payload: "not json",
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
