import fastify, { FastifyServerOptions } from "fastify";
import fastifyWebsocket from "fastify-websocket";
import fastifyCors from "fastify-cors";
import Long from "long";

import "./db/db";
import { getInfo, estimateFee } from "./utils/lnd-api";
import { getGrpcClients } from "./utils/grpc";

const { lightning, router } = getGrpcClients();

export default function (options?: FastifyServerOptions) {
  const app = fastify(options);
  app.register(fastifyWebsocket, {});
  app.register(fastifyCors);

  app.get("/", async () => "hello, world");

  app.register(import("./services/ondemand-channel/index"), {
    prefix: "/ondemand-channel",
    lightning,
    router,
  });

  app.get("/estimateFee", async function () {
    return await estimateFee(lightning, Long.fromValue(100000), 1);
  });

  app.get("/getInfo", async function () {
    return await getInfo(lightning);
  });

  return app;
}
