import { randomBytes } from "crypto";
import { AddressInfo } from "net";
import { bech32 } from "bech32";
import secp256k1 from "secp256k1";
// ws ships without type declarations in this project.
const WebSocket = require("ws");

import build from "../../../src/app";
import getDb from "../../../src/db/db";
import { createAdmin } from "../../../src/db/admin";
import { bytesToHexString } from "../../../src/utils/common";
import {
  MAX_LOGIN_SOCKETS,
  MAX_LOGIN_SOCKETS_PER_CLIENT,
} from "../../../src/services/admin/api/login";

const HTTPS = { "x-forwarded-proto": "https" };

function cookieFrom(setCookie: string | string[] | undefined) {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) {
    throw new Error("Expected a session cookie");
  }
  return header.split(";")[0];
}

function nextMessage(socket: any) {
  return new Promise<any>((resolve, reject) => {
    socket.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
}

describe("admin LNURL-auth login", () => {
  test("issues a new session at login and accepts each k1 only once", async () => {
    const app = build({ trustProxy: true });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    try {
      const db = await getDb();
      let privateKey: Buffer;
      do {
        privateKey = randomBytes(32);
      } while (!secp256k1.privateKeyVerify(privateKey));
      const pubkey = bytesToHexString(secp256k1.publicKeyCreate(privateKey));
      await createAdmin(db, pubkey, "Test admin");

      const preLogin = await app.inject({
        method: "GET",
        url: "/admin/api/login-session",
        headers: HTTPS,
      });
      const preLoginCookie = cookieFrom(preLogin.headers["set-cookie"]);

      const socket = new WebSocket(`ws://127.0.0.1:${port}/admin/api/login-ws`, {
        headers: { cookie: preLoginCookie, origin: `http://127.0.0.1:${port}` },
      });
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send("GET_LNURL");
      const { lnurlAuth } = await nextMessage(socket);
      const url = new URL(
        Buffer.from(bech32.fromWords(bech32.decode(lnurlAuth, 2000).words)).toString(),
      );
      const k1 = url.searchParams.get("k1")!;

      const signature = secp256k1.signatureExport(
        secp256k1.ecdsaSign(Buffer.from(k1, "hex"), privateKey).signature,
      );
      const loginUrl = `/admin/api/login?tag=login&k1=${k1}&sig=${bytesToHexString(
        signature,
      )}&key=${pubkey}`;

      const approved = nextMessage(socket);
      const walletCallback = await app.inject({ method: "GET", url: loginUrl });
      expect(walletCallback.statusCode).toBe(200);
      expect(await approved).toEqual({ status: "OK" });

      // The same k1 can't log in again.
      const replay = await app.inject({ method: "GET", url: loginUrl });
      expect(replay.statusCode).toBe(400);

      const completion = await app.inject({
        method: "POST",
        url: "/admin/api/login-complete",
        headers: { ...HTTPS, cookie: preLoginCookie },
      });
      expect(completion.statusCode).toBe(200);
      const adminCookie = cookieFrom(completion.headers["set-cookie"]);
      expect(adminCookie).not.toBe(preLoginCookie);

      const withAdminCookie = await app.inject({
        method: "GET",
        url: "/admin/api/admins",
        headers: { ...HTTPS, cookie: adminCookie },
      });
      expect(withAdminCookie.statusCode).toBe(200);

      // The cookie from before login is worthless.
      const withPreLoginCookie = await app.inject({
        method: "GET",
        url: "/admin/api/admins",
        headers: { ...HTTPS, cookie: preLoginCookie },
      });
      expect(withPreLoginCookie.statusCode).toBe(403);

      socket.close();
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
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/login-complete",
      headers: HTTPS,
    });
    expect(response.statusCode).toBe(403);
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
