import config from "config";
import { randomBytes } from "crypto";

import build from "../../../../src/app";
import getDb from "../../../../src/db/db";
import { getChannelRequest } from "../../../../src/db/ondemand-channel";
import {
  __resetSignedRequestState,
  __signedRequestStateSize,
  parseSignedEnvelope,
  verifySignedEnvelope,
} from "../../../../src/services/ondemand-channel/api/signed-request";
import { IRegisterOkResponse } from "../../../../src/services/ondemand-channel/api/register";

const REGISTER = "/ondemand-channel/register";

function signedBody(
  overrides: Record<string, unknown> = {},
  data: Record<string, unknown> = {
    amountSat: 20_000,
    preimage: randomBytes(32).toString("hex"),
  },
) {
  const message = JSON.stringify({
    endpoint: REGISTER,
    domain: "domain.com",
    timestamp: Math.floor(Date.now() / 1000),
    nonce: randomBytes(16).toString("hex"),
    data,
    ...overrides,
  });
  return { message, signature: "validsig", pubkey: "abcdef12345" };
}

function post(app: ReturnType<typeof build>, body: unknown) {
  return app.inject({
    url: REGISTER,
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    payload: JSON.stringify(body),
  });
}

/** Overrides single config keys for one test. */
function withConfig(overrides: Record<string, unknown>) {
  // The config object itself is frozen; its methods live on the prototype.
  const proto = Object.getPrototypeOf(config);
  const originalHas = proto.has;
  const originalGet = proto.get;
  const has = jest.spyOn(proto, "has").mockImplementation(function (this: any, key: any) {
    return key in overrides || originalHas.call(this, key);
  });
  const get = jest.spyOn(proto, "get").mockImplementation(function (this: any, key: any) {
    return key in overrides ? overrides[key] : originalGet.call(this, key);
  });
  return () => {
    has.mockRestore();
    get.mockRestore();
  };
}

describe("signed requests", () => {
  beforeEach(() => {
    __resetSignedRequestState();
  });

  test("a message is refused again for as long as its timestamp is accepted", async () => {
    // Signed 30s ahead, first used just after a whole second.
    const body = signedBody({ timestamp: 1030 });
    const use = async (nowMs: number) => {
      const envelope = parseSignedEnvelope(body, REGISTER, "REGISTER", nowMs);
      if (!envelope.ok) {
        return envelope.reason;
      }
      const verified = await verifySignedEnvelope({} as any, envelope.value, nowMs);
      return verified.ok ? "OK" : verified.reason;
    };

    expect(await use(1_000_001)).toBe("OK");
    // Still within the timestamp check (1060 - 1030 = 30).
    expect(await use(1_060_500)).toMatch(/already been used/);
    expect(await use(1_061_000)).toMatch(/too old/);
  });

  test("cleans up used messages and rate-limit windows at most once a second", async () => {
    const use = async (nowMs: number) => {
      const body = signedBody({ timestamp: Math.floor(nowMs / 1000) });
      const envelope = parseSignedEnvelope(body, REGISTER, "REGISTER", nowMs);
      if (!envelope.ok) {
        throw new Error(envelope.reason);
      }
      return verifySignedEnvelope({} as any, envelope.value, nowMs);
    };

    await use(1_000_000); // sweeps (the first call), then records its message
    await use(1_000_500); // within a second of that sweep: no sweep
    expect(__signedRequestStateSize().consumedMessages).toBe(2);

    // Much later: this call sweeps both expired messages and the expired
    // rate-limit window, then records its own.
    expect((await use(1_100_000)).ok).toBe(true);
    expect(__signedRequestStateSize()).toEqual({ consumedMessages: 1, requestCounts: 1 });
  });

  test("registers with a signed message and takes the fields from the signed data", async () => {
    const app = build();
    const body = signedBody({}, { amountSat: 12_345, preimage: "ab".repeat(32) });

    // Unsigned fields in the body are ignored.
    const response = await post(app, { ...body, amountSat: 999_999 });

    expect(response.statusCode).toBe(200);
    const { fakeChannelId } = response.json() as IRegisterOkResponse;
    const request = await getChannelRequest(await getDb(), fakeChannelId);
    expect(request?.expectedAmountSat).toBe(12_345);
    expect(request?.preimage).toBe("ab".repeat(32));
    await app.close();
  });

  test("rejects a signed message that is used twice", async () => {
    const app = build();
    const body = signedBody();

    expect((await post(app, body)).statusCode).toBe(200);
    const replay = await post(app, body);

    expect(replay.statusCode).toBe(400);
    expect(replay.json().reason).toMatch(/already been used/);
    await app.close();
  });

  test.each([
    ["too old", { timestamp: Math.floor(Date.now() / 1000) - 120 }, /too old/],
    ["from the future", { timestamp: Math.floor(Date.now() / 1000) + 120 }, /too old/],
    ["for another service", { domain: "lightning-box.example" }, /different service/],
    ["for another endpoint", { endpoint: "/ondemand-channel/claim" }, /different endpoint/],
    ["without a nonce", { nonce: "" }, /Invalid signed message/],
    // lnd would verify "š" (U+0161) as the byte 0x61 ("a"): same signature,
    // different text for the replay check.
    ["with non-ASCII text", { nonce: "š".repeat(16) }, /Invalid signed message/],
  ])("rejects a message %s", async (_name, overrides, reason) => {
    const app = build();
    const response = await post(app, signedBody(overrides));

    expect(response.statusCode).toBe(400);
    expect(response.json().reason).toMatch(reason);
    await app.close();
  });

  test("rejects a signature from a different key than the claimed pubkey", async () => {
    const app = build();
    const response = await post(app, { ...signedBody(), pubkey: "someone-else" });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  test("rejects legacy signatures once they are turned off", async () => {
    const restore = withConfig({ allowLegacySignatures: false });
    try {
      const result = parseSignedEnvelope(
        JSON.stringify({ pubkey: "abcdef12345", signature: "validsig", amountSat: 1 }),
        REGISTER,
        "REGISTER",
      );
      expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/update your wallet/) });
    } finally {
      restore();
    }
  });

  test("limits requests per pubkey", async () => {
    const restore = withConfig({ signedRequestRateLimitPerMinute: 2 });
    try {
      const envelope = parseSignedEnvelope(
        JSON.stringify({ pubkey: "abcdef12345", signature: "validsig" }),
        "/ondemand-channel/check-status",
        "CHECKSTATUS",
      );
      if (!envelope.ok) {
        throw new Error("Expected a valid envelope");
      }
      expect((await verifySignedEnvelope({} as any, envelope.value)).ok).toBe(true);
      expect((await verifySignedEnvelope({} as any, envelope.value)).ok).toBe(true);
      expect(await verifySignedEnvelope({} as any, envelope.value)).toMatchObject({
        ok: false,
        statusCode: 429,
      });
    } finally {
      restore();
    }
  });

  test("limits unpaid requests per pubkey", async () => {
    const restore = withConfig({ maxOpenRequestsPerPubkey: 2 });
    const app = build();
    try {
      await getDb(true);
      expect((await post(app, signedBody())).statusCode).toBe(200);
      expect((await post(app, signedBody())).statusCode).toBe(200);
      const third = await post(app, signedBody());
      expect(third.statusCode).toBe(429);
    } finally {
      restore();
      await app.close();
    }
  });
});
