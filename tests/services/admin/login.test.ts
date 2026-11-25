import { AddressInfo } from "net";
// ws ships without type declarations in this project.
const WebSocket = require("ws");

import build from "../../../src/app";
import {
  MAX_LOGIN_SOCKETS,
  MAX_LOGIN_SOCKETS_PER_CLIENT,
} from "../../../src/services/admin/api/login";
import {
  approveLogin,
  completeLogin,
  cookieFrom,
  HTTPS,
  loginAsAdmin,
  nextMessage,
} from "./login-helper";

describe("admin LNURL-auth login", () => {
  test("issues a new session at login and accepts each k1 and token only once", async () => {
    const app = build({ trustProxy: true });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const { walletCallback, message, token, loginUrl } = await approveLogin(app);
      expect(walletCallback.statusCode).toBe(200);
      expect(message).toEqual({ status: "OK", token: expect.stringMatching(/^[0-9a-f]{64}$/) });

      // The same k1 can't log in again.
      const replay = await app.inject({ method: "GET", url: loginUrl });
      expect(replay.statusCode).toBe(400);

      const completion = await completeLogin(app, token);
      expect(completion.statusCode).toBe(200);
      const adminCookie = cookieFrom(completion.headers["set-cookie"]);
      const withAdminCookie = await app.inject({
        method: "GET",
        url: "/admin/api/admins",
        headers: { ...HTTPS, cookie: adminCookie },
      });
      expect(withAdminCookie.statusCode).toBe(200);

      // The token is used up.
      expect((await completeLogin(app, token)).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  test("a cookie planted for the login WebSocket doesn't get the login", async () => {
    const app = build({ trustProxy: true });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      // An attacker's cookie, planted so that only the login WebSocket sends
      // it (longer path, sent first). Before, the approval was stored under
      // the WebSocket's session, so this cookie could complete the login.
      const planted = "sessionId=planted-by-attacker";

      const { token } = await approveLogin(app, { ...HTTPS, cookie: planted });
      // The attacker, holding the planted cookie, can't complete the login.
      const stolen = await completeLogin(app, undefined, { ...HTTPS, cookie: planted });
      expect(stolen.statusCode).toBe(403);
      // The admin's browser, holding the token from its WebSocket, can.
      expect((await completeLogin(app, token)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  test("rejects a login WebSocket opened from another site", async () => {
    const app = build();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/admin/api/login-ws`, {
        headers: { origin: "https://evil.example" },
      });
      const code = await new Promise<number>((resolve) => socket.once("close", resolve));
      expect(code).toBe(1008);
    } finally {
      await app.close();
    }
  });

  test("the create-admin WebSocket refuses another origin even with the admin's cookie", async () => {
    const app = build({ trustProxy: true });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    try {
      const { cookie } = await loginAsAdmin(app);

      const open = (origin: string) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/admin/api/create-admin-lnurl-auth-ws`, {
          headers: { ...HTTPS, cookie, origin },
        });
        const messages: any[] = [];
        socket.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));
        return { socket, messages };
      };

      const evil = open("https://other.example.com");
      const code = await new Promise<number>((resolve) => evil.socket.once("close", resolve));
      expect(code).toBe(1008);
      expect(evil.messages).toEqual([]);

      const own = open(`http://127.0.0.1:${port}`);
      const message = await nextMessage(own.socket);
      expect(typeof message.lnurlAuth).toBe("string");
      own.socket.close();
    } finally {
      await app.close();
    }
  });

  test("closes a login WebSocket that sends an oversized message", async () => {
    const app = build();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/admin/api/login-ws`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      await new Promise((resolve) => socket.once("open", resolve));
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      socket.send("x".repeat(2048));
      expect(await closed).toBe(1009); // Message too big
    } finally {
      await app.close();
    }
  });

  test("refuses login WebSockets from one address beyond its limit", async () => {
    const app = build({ trustProxy: true });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const open = (ip: string) =>
      new WebSocket(`ws://127.0.0.1:${port}/admin/api/login-ws`, {
        headers: { origin: `http://127.0.0.1:${port}`, "x-forwarded-for": ip },
      });
    const sockets: any[] = [];
    try {
      for (let i = 0; i < MAX_LOGIN_SOCKETS_PER_CLIENT; i++) {
        const socket = open("198.51.100.30");
        sockets.push(socket);
        await new Promise((resolve) => socket.once("open", resolve));
      }
      const extra = open("198.51.100.30");
      sockets.push(extra);
      expect(await new Promise<number>((resolve) => extra.once("close", resolve))).toBe(1013);

      // Another address still gets in.
      const other = open("198.51.100.31");
      sockets.push(other);
      await new Promise((resolve) => other.once("open", resolve));
      other.send("GET_LNURL");
      expect(await nextMessage(other)).toHaveProperty("lnurlAuth");
    } finally {
      sockets.forEach((socket) => socket.terminate());
      await app.close();
    }
  });

  test("refuses login WebSockets beyond the limit", async () => {
    const app = build({ trustProxy: true });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    let opened = 0;
    // A different address each time, so the per-address limit isn't reached.
    const open = () =>
      new WebSocket(`ws://127.0.0.1:${port}/admin/api/login-ws`, {
        headers: {
          origin: `http://127.0.0.1:${port}`,
          "x-forwarded-for": `10.0.${Math.floor(opened / 250)}.${(opened++ % 250) + 1}`,
        },
      });
    const sockets: any[] = [];
    try {
      for (let i = 0; i < MAX_LOGIN_SOCKETS; i++) {
        const socket = open();
        sockets.push(socket);
        await new Promise((resolve) => socket.once("open", resolve));
      }
      const extra = open();
      sockets.push(extra);
      expect(await new Promise<number>((resolve) => extra.once("close", resolve))).toBe(1013);

      // A slot frees up when a login socket closes.
      const first = sockets[0];
      await new Promise((resolve) => {
        first.once("close", resolve);
        first.close();
      });
      // Let the server handle the close as well.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const next = open();
      sockets.push(next);
      await new Promise((resolve) => next.once("open", resolve));
      next.send("GET_LNURL");
      expect(await nextMessage(next)).toHaveProperty("lnurlAuth");
    } finally {
      sockets.forEach((socket) => socket.terminate());
      await app.close();
    }
  });

  test("completing a login that no wallet approved fails", async () => {
    const app = build();
    for (const token of [undefined, "00".repeat(32), "not hex"]) {
      expect((await completeLogin(app, token)).statusCode).toBe(403);
    }
    await app.close();
  });

  test("rejects malformed LNURL-auth callbacks", async () => {
    const app = build();
    const response = await app.inject({
      method: "GET",
      url: "/admin/api/login?k1=zz&sig=zz&key=zz",
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
