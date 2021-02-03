import { RouteHandlerMethod } from "fastify";
import config from "config";
import { Client } from "@grpc/grpc-js";
import Long from "long";

import { estimateFee } from "../../../utils/lnd-api";
import { checkFeeTooHigh, getMinimumPaymentSat } from "./utils";

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
  return async function () {
    const estimateFeeResponse = await estimateFee(lightning, Long.fromValue(100000), 1);

    // Close down the service if fees are too high
    const status = !checkFeeTooHigh(
      estimateFeeResponse.feerateSatPerByte,
      estimateFeeResponse.feeSat,
    );

    // The miminum payment we'll accept
    const minimumPaymentSat = getMinimumPaymentSat(estimateFeeResponse.feeSat);

    // TODO(hsjoberg): maximum payment?

    const response: IServiceStatusResponse = {
      status,
      approxFeeSat: estimateFeeResponse.feeSat.toNumber(),
      minimumPaymentSat: minimumPaymentSat.toNumber(),
      peer: `${servicePubKey}@${lndNode}`,
    };
    return response;
  };
}
