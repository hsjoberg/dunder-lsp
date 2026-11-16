import { FastifyPluginAsync, RouteHandlerMethod } from "fastify";
import { Client } from "@grpc/grpc-js";
import fastifyStatic from "@fastify/static";
import fastifySession from "@fastify/session";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import path from "path";
import config from "config";

import getDb from "../../db/db";
import { bytesToHexString, generateBytes } from "../../utils/common";
import { BoundedSessionStore } from "./session-store";

export interface IErrorResponse {
  status: "ERROR";
  reason: string;
}

const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SESSION_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;

function isHttpsDeployment() {
  return config.get<string>("serverDomain").toLowerCase().startsWith("https://");
}

const Admin = async function (app, { lightning, router }) {
  const db = await getDb();
  app.register(fastifyCookie);
  app.register(fastifySession, {
    cookie: {
      // When Dunder is configured for HTTPS the cookie is marked Secure. Behind a
      // TLS-terminating reverse proxy, the proxy must send `X-Forwarded-Proto: https`
      // and be listed in `trustProxy`, otherwise @fastify/session refuses to set a
      // Secure cookie.
      secure: isHttpsDeployment(),
      httpOnly: true,
      sameSite: "strict",
      path: "/admin",
      maxAge: SESSION_IDLE_TIMEOUT_MS,
    },
    // Only store a session once something is written to it.
    saveUninitialized: false,
    store: new BoundedSessionStore({
      idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
      absoluteTimeoutMs: SESSION_ABSOLUTE_TIMEOUT_MS,
      maxSessions: MAX_SESSIONS,
    }),
    secret: bytesToHexString(await generateBytes(32)),
  });
  // The login protocol only sends short text messages; ws would otherwise
  // accept messages of up to 100 MB.
  app.register(fastifyWebsocket, { options: { maxPayload: 1024 } });

  app.register(require("./api/index"), {
    prefix: "/api",
    lightning,
    router,
  });

  app.register(fastifyStatic, {
    root: path.join(__dirname, "public"),
    prefix: "/",
  });

  (app.get as any)("/", (request: any, reply: any) => {
    return reply.sendFile("index.html");
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default Admin;
