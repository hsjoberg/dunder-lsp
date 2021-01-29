import config from "config";
if (config.util.getConfigSources().length === 0) {
  throw new Error("Could not find any config sources. Did you forget to create the config file?");
}
import fastify from "fastify";
import fastifyWebsocket from "fastify-websocket";
import fastifyCors from "fastify-cors";
import Long from "long";

import "./db/db.js";
import { getInfo, estimateFee } from "./utils/lnd-api.js";
import { getGrpcClients } from "./utils/grpc.js";

const host = config.get<string>("serverHost");
const domain = host.split(":")[0];
const port = Number.parseInt(host.split(":")[1] ?? "8080");

const { lightning, router } = getGrpcClients();

const server = fastify();
server.register(fastifyWebsocket, {});
server.register(fastifyCors);

server.register(import("./services/ondemand-channel/index.js"), {
  prefix: "/ondemand-channel",
  lightning,
  router,
});

server.get("/estimateFee", async function () {
  return await estimateFee(lightning, Long.fromValue(100000), 1);
});

server.get("/getInfo", async function () {
  return await getInfo(lightning);
});

server.listen(port, domain, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening at ${address}`);
});

export {};
