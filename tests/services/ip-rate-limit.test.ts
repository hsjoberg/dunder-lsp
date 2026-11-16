import config from "config";

import build from "../../src/app";
import { clientKey } from "../../src/services/ip-rate-limit";

/** Overrides single config keys for one test. The config object is frozen. */
function withConfig(overrides: Record<string, unknown>) {
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

describe("per-IP rate limit", () => {
  test("limits the public API per client address", async () => {
    const restore = withConfig({ ipRateLimitPerMinute: 2, trustProxy: true });
    const app = build();
    try {
      const fromA = { "x-forwarded-for": "198.51.100.1" };
      const fromB = { "x-forwarded-for": "198.51.100.2" };

      expect((await app.inject({ url: "/getInfo", headers: fromA })).statusCode).toBe(200);
      expect((await app.inject({ url: "/getInfo", headers: fromA })).statusCode).toBe(200);
      const limited = await app.inject({ url: "/getInfo", headers: fromA });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();

      // Another client is unaffected.
      expect((await app.inject({ url: "/getInfo", headers: fromB })).statusCode).toBe(200);
      // So is the admin interface, apart from the login endpoints.
      expect((await app.inject({ url: "/admin/api/test", headers: fromA })).statusCode).toBe(200);
      const login = { method: "POST" as const, url: "/admin/api/login-complete", headers: fromB };
      expect((await app.inject(login)).statusCode).toBe(403);
      expect((await app.inject(login)).statusCode).toBe(429);
    } finally {
      restore();
      await app.close();
    }
  });

  test("ignores X-Forwarded-For unless trustProxy is set", async () => {
    const restore = withConfig({ ipRateLimitPerMinute: 1 });
    const app = build();
    try {
      expect(
        (await app.inject({ url: "/getInfo", headers: { "x-forwarded-for": "198.51.100.3" } }))
          .statusCode,
      ).toBe(200);
      // A spoofed header doesn't give the same client a fresh limit.
      expect(
        (await app.inject({ url: "/getInfo", headers: { "x-forwarded-for": "198.51.100.4" } }))
          .statusCode,
      ).toBe(429);
    } finally {
      restore();
      await app.close();
    }
  });

  test("service status advertises the request signing version", async () => {
    const app = build();
    try {
      const response = await app.inject({ url: "/ondemand-channel/service-status" });
      expect(response.json().requestSigningVersion).toBe(2);
    } finally {
      await app.close();
    }
  });

  test("can't be skipped with a percent-encoded path", async () => {
    const restore = withConfig({ ipRateLimitPerMinute: 2, trustProxy: true });
    const app = build();
    try {
      const headers = { "x-forwarded-for": "198.51.100.9" };
      // The router decodes these to /getInfo and /ondemand-channel/... .
      const urls = ["/%67etInfo", "/getInfo", "/ondemand%2Dchannel/service-status"];
      const codes = [];
      for (const url of urls) {
        codes.push((await app.inject({ url, headers })).statusCode);
      }
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      restore();
      await app.close();
    }
  });

  test("limits IPv6 clients per /64", async () => {
    const restore = withConfig({ ipRateLimitPerMinute: 1, trustProxy: true });
    const app = build();
    try {
      const from = (ip: string) => ({ url: "/getInfo", headers: { "x-forwarded-for": ip } });
      expect((await app.inject(from("2001:db8:1:2::1"))).statusCode).toBe(200);
      // Another address in the same /64.
      expect((await app.inject(from("2001:db8:1:2:aaaa::7"))).statusCode).toBe(429);
      // Another /64.
      expect((await app.inject(from("2001:db8:1:3::1"))).statusCode).toBe(200);
    } finally {
      restore();
      await app.close();
    }
  });

  test("keys addresses by IPv4 address or IPv6 /64", () => {
    expect(clientKey("198.51.100.1")).toBe("198.51.100.1");
    expect(clientKey("::ffff:198.51.100.1")).toBe("198.51.100.1");
    expect(clientKey("2001:0db8:0001:0002:0000:0000:0000:0001")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });
});
