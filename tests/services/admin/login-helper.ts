import { randomBytes } from "crypto";
import { AddressInfo } from "net";
import { FastifyInstance } from "fastify";
import { bech32 } from "bech32";
import secp256k1 from "secp256k1";
// ws ships without type declarations in this project.
const WebSocket = require("ws");

import getDb from "../../../src/db/db";
import { createAdmin } from "../../../src/db/admin";
import { bytesToHexString } from "../../../src/utils/common";

export const HTTPS = { "x-forwarded-proto": "https" };

export function cookieFrom(setCookie: string | string[] | undefined) {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) {
    throw new Error("Expected a session cookie");
  }
  return header.split(";")[0];
}

export function nextMessage(socket: any) {
  return new Promise<any>((resolve, reject) => {
    socket.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
}

/**
 * Runs the LNURL-auth login up to the wallet's approval and returns the token
 * the login WebSocket received. The app must be listening.
 */
export async function approveLogin(
  app: FastifyInstance,
  socketHeaders: Record<string, string> = {},
) {
  const port = (app.server.address() as AddressInfo).port;
  let privateKey: Buffer;
  do {
    privateKey = randomBytes(32);
  } while (!secp256k1.privateKeyVerify(privateKey));
  const pubkey = bytesToHexString(secp256k1.publicKeyCreate(privateKey));
  await createAdmin(await getDb(), pubkey, "Test admin");

  const socket = new WebSocket(`ws://127.0.0.1:${port}/admin/api/login-ws`, {
    headers: { origin: `http://127.0.0.1:${port}`, ...socketHeaders },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send("GET_LNURL");
  const { lnurlAuth } = await nextMessage(socket);
  const k1 = new URL(
    Buffer.from(bech32.fromWords(bech32.decode(lnurlAuth, 2000).words)).toString(),
  ).searchParams.get("k1")!;
  const signature = secp256k1.signatureExport(
    secp256k1.ecdsaSign(Buffer.from(k1, "hex"), privateKey).signature,
  );
  const loginUrl = `/admin/api/login?tag=login&k1=${k1}&sig=${bytesToHexString(
    signature,
  )}&key=${pubkey}`;

  const approved = nextMessage(socket);
  const walletCallback = await app.inject({ method: "GET", url: loginUrl });
  const message = await approved;
  socket.close();
  return { pubkey, loginUrl, walletCallback, message, token: message.token as string };
}

export function completeLogin(
  app: FastifyInstance,
  token: unknown,
  headers: Record<string, string> = HTTPS,
) {
  return app.inject({
    method: "POST",
    url: "/admin/api/login-complete",
    headers,
    payload: { token },
  });
}

/** Logs in as a new admin and returns the session cookie. */
export async function loginAsAdmin(app: FastifyInstance) {
  const { pubkey, token } = await approveLogin(app);
  const completion = await completeLogin(app, token);
  if (completion.statusCode !== 200) {
    throw new Error(`Login failed: ${completion.statusCode} ${completion.body}`);
  }
  return { pubkey, cookie: cookieFrom(completion.headers["set-cookie"]) };
}
