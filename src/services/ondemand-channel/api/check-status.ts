import { Client } from "@grpc/grpc-js";
import { RouteHandlerMethod } from "fastify";

import { verifyMessage } from "../../../utils/lnd-api.js";
import {
  ChannelRequestStatus,
  getActiveChannelRequestsByPubkey,
  getChannelRequestUnclaimedAmount,
} from "../../../db/ondemand-channel.js";
import db from "../../../db/db.js";

export interface ICheckStatusRequest {
  pubkey: string;
  signature: string;
}

export interface ICheckStatusResponse {
  state: ChannelRequestStatus;
  unclaimedAmountSat: number;
}

export default function CheckStatus(lightning: Client): RouteHandlerMethod {
  return async (request, reply) => {
    const checkStatusRequest = JSON.parse(request.body as string) as ICheckStatusRequest;

    const verifyMessageResponse = await verifyMessage(
      lightning,
      "CHECKSTATUS",
      checkStatusRequest.signature,
    );
    if (checkStatusRequest.pubkey !== verifyMessageResponse.pubkey) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: "Public key mismatch",
      };
      return error;
    }
    const channelRequests = await getActiveChannelRequestsByPubkey(db, checkStatusRequest.pubkey);
    const unclaimed = await getChannelRequestUnclaimedAmount(db, checkStatusRequest.pubkey);

    const response: ICheckStatusResponse = {
      state: channelRequests.length === 0 ? "NOT_REGISTERED" : channelRequests[0].status,
      unclaimedAmountSat: unclaimed,
    };
    return response;
  };
}
