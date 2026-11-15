import build from "../../../src/app";
import { BoundedSessionStore } from "../../../src/services/admin/session-store";

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
    const app = build();
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/admin/api/test",
      headers: { "x-forwarded-proto": "https" },
    });

    expect(response.statusCode).toBe(200);
    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toMatch(/; Secure/);
    expect(setCookie).toMatch(/; HttpOnly/);
    expect(setCookie).toMatch(/; SameSite=Strict/);
    expect(setCookie).toMatch(/; Path=\/admin/);
    expect(setCookie).toMatch(/; Expires=/);
    await app.close();
  });

  test("is not set over plain HTTP when Dunder is configured for HTTPS", async () => {
    const app = build();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/admin/api/test" });

    expect(response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  test("is not created for requests that do not use the session", async () => {
    const app = build();
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
});
