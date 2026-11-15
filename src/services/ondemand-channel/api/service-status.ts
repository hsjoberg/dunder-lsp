import { RouteHandlerMethod } from "fastify";
import config from "config";
import { Client } from "@grpc/grpc-js";
import Long from "long";

import { estimateFee } from "../../../utils/lnd-api";
import {
  checkFeeTooHigh,
  getFeeChargeSat,
  getMaximumPaymentSat,
  getMinimumPaymentSat,
  isChannelOpeningEnabled,
} from "./utils";

export interface IServiceStatusResponse {
  status: boolean;
  approxFeeSat: number;
  minimumPaymentSat: number;
  maximumPaymentSat: number;
  peer: string;
  /**
   * How wallet requests may be signed. 1 (or absent, on older Dunder): the
   * signature covers a fixed word such as "REGISTER". 2: the signature covers a
   * JSON message with endpoint, domain, timestamp, nonce and the request data
   * (see signed-request.ts). Version 1 is still accepted while
   * `allowLegacySignatures` is on.
   */
  requestSigningVersion: number;
}

export default function ServiceStatus(
  lightning: Client,
  servicePubKey: string,
): RouteHandlerMethod {
  const lndNode = config.get<string>("backendConfig.lndNode");
  return async function () {
    // The maximum payment we'll accept
    const maximumPaymentSat = getMaximumPaymentSat();
    const estimateFeeResponse = await estimateFee(lightning, Long.fromValue(maximumPaymentSat), 1);
    // Close down the service if channel opening is disabled or fees are too high
    const status = isChannelOpeningEnabled() && !checkFeeTooHigh(
      estimateFeeResponse.feerateSatPerByte,
      estimateFeeResponse.feeSat,
    );

    // The miminum payment we'll accept
    const minimumPaymentSat = getMinimumPaymentSat(estimateFeeResponse.feeSat);

    // Approx fee
    const response: IServiceStatusResponse = {
      status,
      approxFeeSat: getFeeChargeSat(estimateFeeResponse.feeSat),
      minimumPaymentSat,
      maximumPaymentSat,
      peer: `${servicePubKey}@${lndNode}`,
      requestSigningVersion: 2,
    };
    return response;
  };
}
