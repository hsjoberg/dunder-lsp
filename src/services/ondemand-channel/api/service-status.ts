import { RouteHandlerMethod } from "fastify";
import config from "config";
import { Client } from "@grpc/grpc-js";
import Long from "long";

import { estimateFee } from "../../../utils/lnd-api";

export interface IServiceStatusResponse {
  status: boolean;
  approxFeeSat: number;
  minimumPaymentSat: number;
  peer: string;
}

export default function ServiceStatus(
  lightning: Client,
  servicePubKey: string,
): RouteHandlerMethod {
  const lndNode = config.get<string>("backendConfig.lndNode");
  return async function (request, reply) {
    const estimateFeeResponse = await estimateFee(lightning, Long.fromValue(100000), 1);

    // Close down the service if fees are too high
    const status = !estimateFeeResponse.feerateSatPerByte.greaterThanOrEqual(200);

    // The miminum payment we'll accept is fee * 5
    const minimumPaymentSat = estimateFeeResponse.feeSat.mul(5);

    const response: IServiceStatusResponse = {
      status,
      approxFeeSat: estimateFeeResponse.feeSat.toNumber(),
      minimumPaymentSat: minimumPaymentSat.toNumber(),
      peer: `${servicePubKey}@${lndNode}`,
    };
    return response;
  };
}
