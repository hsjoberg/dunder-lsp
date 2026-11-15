import { Client } from "@grpc/grpc-js";
import config from "config";
import { RouteHandlerMethod } from "fastify";
import { Database } from "sqlite";

import { getChannelRequestUnclaimedAmount } from "../../../db/ondemand-channel";
import { checkPeerConnected } from "../../../utils/lnd-api";
import { openChannelForSettledHtlcs } from "../channel-open";
import { IErrorResponse } from "../index";
import { parseSignedEnvelope, verifySignedEnvelope } from "./signed-request";
import { isChannelOpeningEnabled } from "./utils";

export interface IClaimRequest {
  pubkey: string;
  signature: string; // Legacy scheme: the message is "CLAIM". See signed-request.ts.
}

export interface IClaimResponse {
  status: "OK";
  amountSat: number;
}

export default function Claim(db: Database, lightning: Client): RouteHandlerMethod {
  return async (request, reply) => {
    if (!isChannelOpeningEnabled()) {
      reply.code(503);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: "Dunder is currently not opening channels. Please try again later.",
      };
      return error;
    }

    const envelope = parseSignedEnvelope(request.body, "/ondemand-channel/claim", "CLAIM");
    if (!envelope.ok) {
      reply.code(400);
      const error: IErrorResponse = { status: "ERROR", reason: envelope.reason };
      return error;
    }
    const allowZeroConfChannels = config.get<boolean>("allowZeroConfChannels") || false;
    const allowTaprootChannels = config.get<boolean>("allowTaprootChannels") || false;

    const verified = await verifySignedEnvelope(lightning, envelope.value);
    if (!verified.ok) {
      reply.code(verified.statusCode ?? 400);
      const error: IErrorResponse = { status: "ERROR", reason: verified.reason };
      return error;
    }
    const claimRequest = { pubkey: verified.value };

    // Check if the requester is connected to our Lightning node
    if (!(await checkPeerConnected(lightning, claimRequest.pubkey))) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: "Wallet is not connected to Dunder's Lightning node.",
      };
      return error;
    }

    const unclaimed = await getChannelRequestUnclaimedAmount(db, claimRequest.pubkey);
    reply.send({
      status: "OK",
      amountSat: unclaimed,
    } as IClaimResponse);
    if (unclaimed === 0) {
      return;
    }

    try {
      const result = await openChannelForSettledHtlcs({
        db,
        lightning,
        pubkey: claimRequest.pubkey,
        source: "CLAIM",
        zeroConf: allowZeroConfChannels,
        taprootChannel: allowTaprootChannels,
      });
      if (result.status !== "OPENED" && result.status !== "NO_SETTLEMENTS") {
        console.warn("Claim channel open did not complete", {
          pubkey: claimRequest.pubkey,
          status: result.status,
        });
      }
    } catch (error) {
      // Preserve the existing claim API contract. The amount remains
      // unclaimed and a later claim/auto-heal can retry unless a durable
      // OPENING/UNKNOWN attempt was already recorded.
      console.error("Could not open claim channel", error);
    }
  };
}
