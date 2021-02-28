import { RouteHandlerMethod } from "fastify";
import { Client } from "@grpc/grpc-js";
import { Database } from "sqlite";
import Long from "long";

import {
  getChannelRequestUnclaimedAmount,
  updateHtlcSettlementSetAllAsClaimed,
} from "../../../db/ondemand-channel";
import { checkPeerConnected, openChannelSync, verifyMessage } from "../../../utils/lnd-api";
import { IErrorResponse } from "../index";
import { bytesToHexString } from "../../../utils/common";
import { MIN_CHANNEL_SIZE_SAT } from "../../../utils/constants";

export interface IClaimRequest {
  pubkey: string;
  signature: string; // Message has to be REGISTER base64
}

export interface IClaimResponse {
  status: "OK";
  amountSat: number;
}

export default function Claim(db: Database, lightning: Client): RouteHandlerMethod {
  return async (request, reply) => {
    const claimRequest = JSON.parse(request.body as string) as IClaimRequest;

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

    if (MIN_CHANNEL_SIZE_SAT <= unclaimed) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason:
          "The requested amount is below the minimum requirement of 20000 satoshi." +
          "In order to claim these funds, you need to receive another payment through Dunder.",
      };
      return error;
    }

    reply.send({
      status: "OK",
      amountSat: unclaimed,
    } as IClaimResponse);

    console.log("Opening channel");
    try {
      const result = await openChannelSync(
        lightning,
        claimRequest.pubkey,
        Long.fromValue(unclaimed).mul(2),
        Long.fromValue(unclaimed),
        true,
        true,
      );
      const txId = bytesToHexString(result.fundingTxidBytes.reverse());
      await updateHtlcSettlementSetAllAsClaimed(db, claimRequest.pubkey);
    } catch (error) {
      console.error("Could not open channel", error);
    }
  };
}
