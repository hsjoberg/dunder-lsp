import build from "../../../src/app";
import { BoundedSessionStore } from "../../../src/services/admin/session-store";
import { approveLogin, completeLogin, loginAsAdmin } from "./login-helper";

// HTTPS arrives through a reverse proxy, which Dunder must trust
// (`trustProxy`) to believe its X-Forwarded-Proto header.
const buildBehindProxy = () => build({ trustProxy: true });

function fakeSession(authenticated = false) {
  return { get: (key: string) => (key === "authenticated" ? authenticated : undefined) } as any;
}

function getFromStore(store: BoundedSessionStore, sessionId: string) {
  return new Promise<unknown>((resolve, reject) =>
    store.get(sessionId, (err, session) => (err ? reject(err) : resolve(session))),
  );
}

describe("BoundedSessionStore", () => {
  test("expires sessions after the idle timeout", async () => {
    let now = 0;
    const store = new BoundedSessionStore({
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 10_000,
      maxSessions: 10,
      now: () => now,
    });

    store.set("a", fakeSession(), () => {});
    now = 999;
    await expect(getFromStore(store, "a")).resolves.toBeTruthy();
    now = 1000;
    await expect(getFromStore(store, "a")).resolves.toBeNull();
    expect(store.size).toBe(0);
  });

  test("expires sessions after the absolute timeout even when they keep being saved", async () => {
    let now = 0;
    const store = new BoundedSessionStore({
      idleTimeoutMs: 1000,
      absoluteTimeoutMs: 2500,
      maxSessions: 10,
      now: () => now,
    });

    for (now = 0; now < 2500; now += 500) {
      store.set("a", fakeSession(true), () => {});
    }
    now = 2500;
    await expect(getFromStore(store, "a")).resolves.toBeNull();
  });

  test("compareAndSet only replaces the session generation it was loaded from", async () => {
    const store = new BoundedSessionStore({
      idleTimeoutMs: 60_000,
      absoluteTimeoutMs: 60_000,
      maxSessions: 10,
    });
    const compareAndSet = (id: string, generation: string) =>
      new Promise<unknown>((resolve) =>
        store.compareAndSet(id, generation, fakeSession(true), (error) => resolve(error)),
      );

    // Destroyed (logout): not brought back.
    store.set("a", fakeSession(), () => {});
    store.destroy("a", () => {});
    expect(await compareAndSet("a", "a")).toMatchObject({ code: "ENOENT" });
    await expect(getFromStore(store, "a")).resolves.toBeNull();

    // Regenerated (login) under the same store key: an older generation loses.
    const regenerated = { ...fakeSession(), __fastifySessionMetadata: { generation: "new" } };
    store.set("b", regenerated as any, () => {});
    expect(await compareAndSet("b", "old")).toMatchObject({ code: "ENOENT" });
    expect(await compareAndSet("b", "new")).toBeUndefined();
  });

  test("evicts the oldest unauthenticated sessions first when full", async () => {
    const store = new BoundedSessionStore({
      idleTimeoutMs: 60_000,
      absoluteTimeoutMs: 60_000,
      maxSessions: 3,
    });

    store.set("admin", fakeSession(true), () => {});
    for (let i = 0; i < 100; i++) {
      store.set(`anonymous-${i}`, fakeSession(), () => {});
    }

    expect(store.size).toBe(3);
    await expect(getFromStore(store, "admin")).resolves.toBeTruthy();
    await expect(getFromStore(store, "anonymous-99")).resolves.toBeTruthy();
    await expect(getFromStore(store, "anonymous-0")).resolves.toBeNull();
  });
});

describe("admin session cookie", () => {
  test("is Secure, HttpOnly, SameSite=Strict and scoped to /admin", async () => {
    const app = buildBehindProxy();
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const { token } = await approveLogin(app);
      const response = await completeLogin(app, token);

      expect(response.statusCode).toBe(200);
      const setCookie = String(response.headers["set-cookie"]);
      expect(setCookie).toMatch(/; Secure/);
      expect(setCookie).toMatch(/; HttpOnly/);
      expect(setCookie).toMatch(/; SameSite=Strict/);
      expect(setCookie).toMatch(/; Path=\/admin/);
      expect(setCookie).toMatch(/; Expires=/);
    } finally {
      await app.close();
    }
  });

  test("is not set over plain HTTP when Dunder is configured for HTTPS", async () => {
    const app = buildBehindProxy();
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const { token } = await approveLogin(app);
      const response = await completeLogin(app, token, {});

      // Not even the logged-in session's cookie, which the session plugin
      // would otherwise send in the clear.
      expect(response.statusCode).toBe(403);
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  test("is not created for requests that do not use the session", async () => {
    const app = buildBehindProxy();
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/admin/api/admins",
      headers: { "x-forwarded-proto": "https" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  test("no longer works after logout", async () => {
    const app = buildBehindProxy();
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const { cookie } = await loginAsAdmin(app);
      const headers = { cookie, "x-forwarded-proto": "https" };
      expect((await app.inject({ url: "/admin/api/admins", headers })).statusCode).toBe(200);

      // A GET (a link or image on another page) no longer logs out.
      expect((await app.inject({ url: "/admin/api/logout", headers })).statusCode).toBe(404);
      // Nor does a POST from a page on another subdomain.
      const crossOrigin = await app.inject({
        method: "POST",
        url: "/admin/api/logout",
        headers: { ...headers, origin: "https://evil.example.com" },
      });
      expect(crossOrigin.statusCode).toBe(403);
      expect((await app.inject({ url: "/admin/api/admins", headers })).statusCode).toBe(200);

      const logout = await app.inject({
        method: "POST",
        url: "/admin/api/logout",
        // app.inject's Host is localhost:80.
        headers: { ...headers, origin: "https://localhost:80" },
      });
      expect(logout.statusCode).toBe(200);

      expect((await app.inject({ url: "/admin/api/admins", headers })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
