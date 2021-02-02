import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";
import { Database } from "sqlite";

import { getInfo, listPeers } from "../../utils/lnd-api";
import Register from "./api/register";
import ServiceStatus from "./api/service-status";
import CheckStatus from "./api/check-status";
import Claim from "./api/claim";
import getDb from "../../db/db";

export interface IErrorResponse {
  status: "ERROR";
  reason: string;
}

const OnDemandChannel = async function (app, { lightning, router }) {
  const db = await getDb();
  // Figure out the pubkey of our own node
  const servicePubKey = (await getInfo(lightning)).identityPubkey;

  app.get("/service-status", ServiceStatus(lightning, servicePubKey));
  app.post("/register", Register(db, lightning, router, servicePubKey));
  app.post("/check-status", CheckStatus(db, lightning));
  app.post("/claim", Claim(lightning));
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default OnDemandChannel;
