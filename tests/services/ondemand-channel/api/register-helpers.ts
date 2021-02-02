import { FastifyInstance } from "fastify";
import Long from "long";

import { MSAT } from "../../../../src/utils/constants";
import { routerrpc } from "../../../../src/proto";
import { IRegisterRequest } from "../../../../src/services/ondemand-channel/api/register";

export async function sendRegisterRequest(
  app: FastifyInstance,
  { amount, preimage, pubkey }: IRegisterRequest,
) {
  const payload: IRegisterRequest = {
    amount,
    preimage,
    pubkey,
    signature: "validsig",
  };
  return app.inject({
    url: "/ondemand-channel/register",
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
    },
    payload: JSON.stringify(payload),
  });
}

export function createForwardHtlcInterceptRequest(
  amountSat: number,
  fakeChannelId: string,
  paymentHash: Uint8Array,
  htlcPart: Long,
) {
  return routerrpc.ForwardHtlcInterceptRequest.encode({
    outgoingAmountMsat: Long.fromValue(amountSat).mul(MSAT),
    incomingCircuitKey: routerrpc.CircuitKey.create({
      chanId: Long.fromValue(fakeChannelId),
      htlcId: htlcPart,
    }),
    paymentHash,
    outgoingRequestedChanId: Long.fromValue(fakeChannelId),
  }).finish();
}
