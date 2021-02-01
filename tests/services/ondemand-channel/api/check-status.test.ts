import { ICheckStatusRequest } from "../../../..//src/services/ondemand-channel/api/check-status";
import build from "../../../../src/app";
const app = build();

describe("/ondemand-channel/check-status", () => {
  test("works under normal conditions", async () => {
    const response = await app.inject({
      url: "/ondemand-channel/check-status",
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      payload: JSON.stringify({
        pubkey: "abcdef12345",
        signature: "sig123",
      } as ICheckStatusRequest),
    });

    expect(response.statusCode).toBe(200);
  });

  test("fails on erroneous signature", async () => {
    require("../../../../src/utils/lnd-api").__verifyMessageSetValidSig(false);
    const response = await app.inject({
      url: "/ondemand-channel/check-status",
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      payload: JSON.stringify({
        pubkey: "abcdef12345",
        signature: "badsig",
      } as ICheckStatusRequest),
    });

    expect(response.statusCode).toBe(400);
    require("../../../../src/utils/lnd-api").__verifyMessageSetValidSig(true);
  });
});

afterAll(() => {
  app.close();
});
