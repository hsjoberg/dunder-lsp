import { randomBytes } from "crypto";
import { FastifyPluginAsync, FastifyRequest } from "fastify";
import { Client } from "@grpc/grpc-js";
import { SessionStore } from "@fastify/session";
import secp256k1 from "secp256k1";
import type { WebSocket } from "ws";
import config from "config";

import {
  bytesToHexString,
  createLnUrlAuth,
  generateBytes,
  hexToUint8Array,
  LnUrlAuthQuerystring,
} from "../../../../utils/common";
import getDb from "../../../../db/db";
import { checkAdminPubkey } from "../../../../db/admin";

export interface IErrorResponse {
  status: "ERROR";
  reason: string;
}

interface IUser {
  sessionId: string;
  socket: WebSocket;
  sessionStore: SessionStore;
  session: FastifyRequest["session"];
  k1: string;
}
const users: Map<WebSocket, IUser> = new Map();

// Login WebSockets can be opened by anyone before logging in, so their number
// and lifetime are bounded. A login takes a minute or two.
export const MAX_LOGIN_SOCKETS = 100;
const LOGIN_SOCKET_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Logins approved by a wallet, waiting for the browser to complete them.
 * Keyed by the browser's pre-login session ID.
 */
const PENDING_LOGIN_TTL_MS = 2 * 60 * 1000;
const pendingLogins: Map<string, { pubkey: string; expiresAt: number }> = new Map();

function sweepPendingLogins(now: number) {
  for (const [sessionId, pending] of pendingLogins) {
    if (pending.expiresAt <= now) {
      pendingLogins.delete(sessionId);
    }
  }
}

function isHex(value: unknown, minLength: number, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minLength &&
    value.length <= maxLength &&
    value.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(value)
  );
}

/** A browser WebSocket always sends Origin; it must be this server. */
function isSameOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

const AdminLogin = async function (app, { lightning, router }) {
  const db = await getDb();

  app.get("/test", async (request) => {
    request.session.set<any>("lnurlAuthSession", true);
    return "1";
  });

  app.get(
    "/login-ws",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      if (!isSameOrigin(request)) {
        socket.close(1008, "Origin not allowed");
        return;
      }
      if (users.size >= MAX_LOGIN_SOCKETS) {
        socket.close(1013, "Too many logins in progress");
        return;
      }

      const serverDomain = config.get<string>("serverDomain");

      const sessionId = request.session.sessionId;
      // Synchronous, so the message handler below is attached before any
      // message can arrive.
      const k1 = randomBytes(32).toString("hex");

      users.set(socket, {
        sessionId: sessionId,
        socket,
        sessionStore: request.sessionStore,
        session: request.session,
        k1,
      });

      socket.on("message", (message: any) => {
        const text = message.toString();
        if (text === "GET_LNURL") {
          const bech32Data = createLnUrlAuth(k1, `${serverDomain}/admin/api/login`);

          socket.send(
            JSON.stringify({
              lnurlAuth: bech32Data,
            }),
          );
        } else {
          socket.send(
            JSON.stringify({
              status: "ERROR",
              reason: "Unknown request",
            }),
          );
        }
      });

      const timeout = setTimeout(
        () => socket.close(1000, "Login timed out"),
        LOGIN_SOCKET_TIMEOUT_MS,
      );
      timeout.unref?.();

      socket.on("close", () => {
        clearTimeout(timeout);
        users.delete(socket);
      });
    },
  );

  app.get<{
    Querystring: LnUrlAuthQuerystring;
  }>("/login", async (request, reply: any) => {
    const { k1, sig, key } = (request.query ?? {}) as Partial<LnUrlAuthQuerystring>;
    if (!isHex(k1, 64, 64) || !isHex(sig, 16, 146) || !isHex(key, 66, 66)) {
      reply.code(400);
      const error: IErrorResponse = { status: "ERROR", reason: "Invalid LNURL-auth request." };
      return error;
    }

    const u = [...users].filter(([_, user]) => {
      return user.k1 === k1;
    });
    if (u.length === 0) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: "Couldn't find the corresponding session.",
      };
      return error;
    }

    // Verify that the message is valid
    let valid = false;
    try {
      const signature = secp256k1.signatureImport(hexToUint8Array(sig));
      valid = secp256k1.ecdsaVerify(signature, hexToUint8Array(k1), hexToUint8Array(key));
    } catch {
      valid = false;
    }
    if (!valid) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason:
          "The Public key provided doesn't match with the public key extracted from the signature. " +
          "Either the signature is wrong or you have signed with the wrong wallet.",
      };
      return error;
    }

    if (!(await checkAdminPubkey(db, key))) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: `The public key "${key}" is not a valid administrator.`,
      };
      return error;
    }

    // The browser completes the login itself (POST /login-complete), so it
    // gets a fresh session ID. Each k1 can be used for one login only.
    const now = Date.now();
    sweepPendingLogins(now);
    for (const [_, user] of u) {
      pendingLogins.set(user.sessionId, { pubkey: key, expiresAt: now + PENDING_LOGIN_TTL_MS });
      user.k1 = bytesToHexString(await generateBytes(32));
      user.socket.send(
        JSON.stringify({
          status: "OK",
        }),
      );
    }

    return reply.send({ status: "OK" });
  });

  app.post("/login-complete", async (request, reply) => {
    const now = Date.now();
    sweepPendingLogins(now);
    const previousSessionId = request.session.sessionId;
    const pending = pendingLogins.get(previousSessionId);
    if (!pending) {
      reply.code(403);
      const error: IErrorResponse = { status: "ERROR", reason: "No approved login found." };
      return error;
    }
    pendingLogins.delete(previousSessionId);

    if (!(await checkAdminPubkey(db, pending.pubkey))) {
      reply.code(403);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: `The public key "${pending.pubkey}" is not a valid administrator.`,
      };
      return error;
    }

    // New session ID at login, so a session ID seen before login is useless:
    // @fastify/session keeps the stored session under the same store key but
    // no longer accepts a cookie with the old ID.
    await request.session.regenerate();
    request.session.set<any>("authenticated", true);
    request.session.set<any>("pubkey", pending.pubkey);
    return { status: "OK" };
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default AdminLogin;
