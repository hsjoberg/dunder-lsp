import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";

import { getInfo, listPeers } from "../../utils/lnd-api.js";
import Register from "./api/register.js";
import ServiceStatus from "./api/service-status.js";
import CheckStatus from "./api/check-status.js";
import Claim from "./api/claim.js";

export interface IErrorResponse {
  status: "ERROR";
  reason: string;
}

const OnDemandChannel = async function (app, { lightning, router }) {
  // Figure out the pubkey of our own node
  const servicePubKey = (await getInfo(lightning)).identityPubkey;

  app.get("/service-status", ServiceStatus(lightning, servicePubKey));
  app.post("/register", Register(lightning, router, servicePubKey));
  app.post("/check-status", CheckStatus(lightning));
  app.post("/claim", Claim(lightning));
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default OnDemandChannel;

export async function checkPeerConnected(lightning: Client, pubkey: string) {
  const listPeersResponse = await listPeers(lightning);
  const seekPeer = listPeersResponse.peers.find((peer) => {
    return peer.pubKey === pubkey;
  });

  return !!seekPeer;
}
