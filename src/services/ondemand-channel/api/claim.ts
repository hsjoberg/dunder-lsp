import { checkPeerConnected, openChannelSync, verifyMessage } from "../../../utils/lnd-api";
import {
  getChannelRequestUnclaimedAmount,
  updateChannelRequestSetAllRegisteredAsDone,
  updateHtlcSettlementSetAllAsClaimed,
} from "../../../db/ondemand-channel";

import { Client } from "@grpc/grpc-js";
import { Database } from "sqlite";
import { IErrorResponse } from "../index";
import Long from "long";
import { RouteHandlerMethod } from "fastify";
import { bytesToHexString } from "../../../utils/common";
import config from "config";
import { getMaximumPaymentSat } from "./utils";

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
    const maximumPaymentSat = getMaximumPaymentSat();
    const claimRequest = JSON.parse(request.body as string) as IClaimRequest;
    const allowZeroConfChannels = config.get<boolean>("allowZeroConfChannels") || false;

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

    // Only attempt a zero conf channel if the config allows it
    if (!!allowZeroConfChannels) {
      console.log("Opening zero-conf channel");
      try {
        const result = await openChannelSync(
          lightning,
          claimRequest.pubkey,
          Long.fromValue(maximumPaymentSat).add(10_000),
          Long.fromValue(unclaimed),
          true,
          true,
          true,
        );
        const txId = bytesToHexString(result.fundingTxidBytes!.reverse());
        await updateChannelRequestSetAllRegisteredAsDone(
          db,
          claimRequest.pubkey,
          `${txId}:${result.outputIndex}`,
        );
        await updateHtlcSettlementSetAllAsClaimed(db, claimRequest.pubkey);

        // Return early if the channel open succeeds.
        return;
      } catch (error) {
        console.error("Could not open zero-conf channel", error);
      }
    }

    // If the zero conf attempt fails, attempt a regular channel
    console.log("Opening regular channel");
    try {
      const result = await openChannelSync(
        lightning,
        claimRequest.pubkey,
        Long.fromValue(maximumPaymentSat).add(10_000),
        Long.fromValue(unclaimed),
        true,
        true,
        false,
      );
      const txId = bytesToHexString(result.fundingTxidBytes!.reverse());
      await updateChannelRequestSetAllRegisteredAsDone(
        db,
        claimRequest.pubkey,
        `${txId}:${result.outputIndex}`,
      );
      await updateHtlcSettlementSetAllAsClaimed(db, claimRequest.pubkey);

      return;
    } catch (error) {
      console.error("Could not open regular channel", error);
    }
  };
}
