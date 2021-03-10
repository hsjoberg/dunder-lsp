import { FastifyPluginAsync, RouteHandlerMethod } from "fastify";
import { Client } from "@grpc/grpc-js";
import fastifyStatic from "fastify-static";
import fastifySession from "fastify-session";
import fastifyCookie from "fastify-cookie";
import path from "path";

import getDb from "../../db/db";
import { bytesToHexString, generateBytes } from "../../utils/common";

export interface IErrorResponse {
  status: "ERROR";
  reason: string;
}

const Admin = async function (app, { lightning, router }) {
  const db = await getDb();
  app.register(fastifyCookie);
  app.register(fastifySession, {
    cookie: { secure: false },
    secret: bytesToHexString(await generateBytes(32)),
  });
  app.register(require("fastify-websocket"));

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
    return reply.sendFile("./index.html");
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default Admin;
