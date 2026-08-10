import { Client } from "@grpc/grpc-js";
import config from "config";
import { RouteHandlerMethod } from "fastify";
import { Database } from "sqlite";

import { getChannelRequestUnclaimedAmount } from "../../../db/ondemand-channel";
import { checkPeerConnected, verifyMessage } from "../../../utils/lnd-api";
import { openChannelForSettledHtlcs } from "../channel-open";
import { IErrorResponse } from "../index";

export interface IClaimRequest {
  pubkey: string;
  signature: string; // Message has to be CLAIM base64
}

export interface IClaimResponse {
  status: "OK";
  amountSat: number;
}

export default function Claim(db: Database, lightning: Client): RouteHandlerMethod {
  return async (request, reply) => {
    const claimRequest = JSON.parse(request.body as string) as IClaimRequest;
    const allowZeroConfChannels = config.get<boolean>("allowZeroConfChannels") || false;
    const allowTaprootChannels = config.get<boolean>("allowTaprootChannels") || false;

    // Verify that the message is valid
    const verifyMessageResponse = await verifyMessage(lightning, "CLAIM", claimRequest.signature);
    if (claimRequest.pubkey !== verifyMessageResponse.pubkey) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason:
          "The Public key provided doesn't match with the public key extracted from the signature. " +
          "Either the signature is wrong or you have signed with the wrong wallet.",
      };
      return error;
    }

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
        spendUnconfirmed: true,
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
