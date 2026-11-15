import { Client } from "@grpc/grpc-js";
import { RouteHandlerMethod } from "fastify";

import {
  ChannelRequestStatus,
  getActiveChannelRequestsByPubkey,
  getChannelRequestUnclaimedAmount,
} from "../../../db/ondemand-channel";
import { IErrorResponse } from "../index";
import { Database } from "sqlite";
import { parseSignedEnvelope, verifySignedEnvelope } from "./signed-request";

export interface ICheckStatusRequest {
  pubkey: string;
  signature: string;
}

export interface ICheckStatusResponse {
  state: ChannelRequestStatus;
  unclaimedAmountSat: number;
}

export default function CheckStatus(db: Database, lightning: Client): RouteHandlerMethod {
  return async (request, reply) => {
    const envelope = parseSignedEnvelope(
      request.body,
      "/ondemand-channel/check-status",
      "CHECKSTATUS",
    );
    if (!envelope.ok) {
      reply.code(400);
      const error: IErrorResponse = { status: "ERROR", reason: envelope.reason };
      return error;
    }
    const verified = await verifySignedEnvelope(lightning, envelope.value);
    if (!verified.ok) {
      reply.code(verified.statusCode ?? 400);
      const error: IErrorResponse = { status: "ERROR", reason: verified.reason };
      return error;
    }
    const checkStatusRequest = { pubkey: verified.value };

    const channelRequests = await getActiveChannelRequestsByPubkey(db, checkStatusRequest.pubkey);
    const unclaimed = await getChannelRequestUnclaimedAmount(db, checkStatusRequest.pubkey);

    const response: ICheckStatusResponse = {
      state: channelRequests.length === 0 ? "NOT_REGISTERED" : channelRequests[0].status,
      unclaimedAmountSat: unclaimed,
    };
    return response;
  };
}
