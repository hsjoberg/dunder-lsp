import build, { isAdminPath } from "../src/app";

const preflight = (url: string) => ({
  method: "OPTIONS" as const,
  url,
  headers: {
    origin: "https://evil.example",
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  },
});

describe("CORS", () => {
  test("answers preflight requests for the public API", async () => {
    const app = build();
    try {
      const response = await app.inject(preflight("/ondemand-channel/register"));
      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("https://evil.example");
    } finally {
      await app.close();
    }
  });

  test("never allows another origin on the admin API, preflight or not", async () => {
    const app = build();
    try {
      for (const url of ["/admin/api/admins", "/%61dmin/api/admins"]) {
        const response = await app.inject(preflight(url));
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      }
      const get = await app.inject({
        url: "/admin/api/admins",
        headers: { origin: "https://evil.example" },
      });
      expect(get.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  test("decides by the matched route or the URL, as sent or decoded", () => {
    expect(isAdminPath("/admin/api/admins", "/%61dmin/api/admins")).toBe(true);
    expect(isAdminPath("*", "/admin/api/admins")).toBe(true);
    expect(isAdminPath("*", "/%61dmin/api/admins")).toBe(true);
    expect(isAdminPath("*", "/%E0%A4%A")).toBe(false);
    expect(isAdminPath("/getInfo", "/getInfo")).toBe(false);
  });
});
