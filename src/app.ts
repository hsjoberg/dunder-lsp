import fastify, { FastifyServerOptions } from "fastify";
import fastifyCors from "fastify-cors";
import fastifyRateLimit from "fastify-rate-limit";
import Long from "long";

import { getInfo, estimateFee } from "./utils/lnd-api";
import { getGrpcClients } from "./utils/grpc";
import { assertEnvironment } from "./utils/common";

const { lightning, router } = getGrpcClients();

assertEnvironment();

export default function (options?: FastifyServerOptions) {
  const app = fastify(options);
  app.register(fastifyCors);

  app.register(fastifyRateLimit,
    {
      global: true, // apply these settings to all the routes of the context
      max: 100, // max requests per timeWindow. Default is 1000 reqs (in 1 minute)
      timeWindow: 15 * 1000 // milliseconds. Default is 1 minute = 60 * 1000
    })

  app.get("/", async () => "hello, world");

  app.register(require("./services/ondemand-channel/index"), {
    prefix: "/ondemand-channel",
    lightning,
    router,
  });

  app.register(require("./services/admin/index"), {
    prefix: "/admin",
    lightning,
    router,
  });

  app.get<{
    Querystring: { targetConf?: string };
  }>("/estimateFee", async function (request) {
    console.log("estimateFee", +(request.query.targetConf ?? 1), typeof request.query.targetConf);
    return await estimateFee(lightning, Long.fromValue(100000), +(request.query.targetConf ?? 1));
  });

  app.get("/getInfo", async function () {
    return await getInfo(lightning);
  });

  return app;
}
