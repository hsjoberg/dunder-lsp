import { FastifyInstance } from "fastify";
import Long from "long";

import { MSAT } from "../../../../src/utils/constants";
import { routerrpc } from "../../../../src/proto";
import { IRegisterRequest } from "../../../../src/services/ondemand-channel/api/register";

export async function sendRegisterRequest(
  app: FastifyInstance,
  { amountSat, preimage, pubkey }: IRegisterRequest,
) {
  const payload: IRegisterRequest = {
    amountSat,
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
  incomingChanId: Long,
  htlcPart: Long,
) {
  return routerrpc.ForwardHtlcInterceptRequest.encode({
    outgoingAmountMsat: Long.fromValue(amountSat).mul(MSAT),
    incomingCircuitKey: routerrpc.CircuitKey.create({
      chanId: incomingChanId,
      htlcId: htlcPart,
    }),
    paymentHash,
    outgoingRequestedChanId: Long.fromValue(fakeChannelId),
    // Plenty of blocks before lnd would auto-fail it (mocked height 800 000).
    incomingExpiry: 800_200,
    autoFailHeight: 800_187,
  }).finish();
}

/** A 32-byte preimage whose leading bytes are `prefix`. */
export function createPreimage(...prefix: number[]) {
  const preimage = new Uint8Array(32);
  preimage.set(prefix);
  return preimage;
}
