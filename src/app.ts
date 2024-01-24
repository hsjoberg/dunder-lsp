import fastify, { FastifyServerOptions } from "fastify";
import fastifyCors from "fastify-cors";
import Long from "long";
import config from "config";

import { getInfo, estimateFee } from "./utils/lnd-api";
import { getGrpcClients } from "./utils/grpc";
import { assertEnvironment } from "./utils/common";

const { lightning, router } = getGrpcClients();

assertEnvironment();

export default function (options?: FastifyServerOptions) {
  const app = fastify(options);
  app.register(fastifyCors);

  app.get("/", async () => "hello, world");

  app.register(require("./services/ondemand-channel/index"), {
    prefix: "/ondemand-channel",
    lightning,
    router,
  });

  const channelLiquidity = config.get<boolean>("channelLiquidityQueryEnabled") || false;
  if (channelLiquidity) {
    app.register(require("./services/channel-liquidity/index"), {
      prefix: "/channel-liquidity",
      lightning,
      router,
    });
  }

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
