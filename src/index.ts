import fastify from "fastify";
import fastifyWebsocket from "fastify-websocket";
import fastifyCors from "fastify-cors";
import Long from "long";

import { getInfo, estimateFee } from "./utils/lnd-api";
import { getGrpcClients } from "./utils/grpc";

const HOST = process.env.DUNDER_HOST;
if (!HOST) {
  console.error("Dunder has to be started with DUNDER_HOST environment variable");
  process.exit(1);
}
const DOMAIN = HOST.split(":")[0];
const PORT = Number.parseInt(HOST.split(":")[1] ?? "8080");

const { lightning, router } = getGrpcClients();

const server = fastify();
server.register(fastifyWebsocket, {});
server.register(fastifyCors);

server.register(require("./ondemand-channel"), {
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

server.listen(PORT, DOMAIN, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening at ${address}`);
});

export {};
