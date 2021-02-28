import Long from "long";
import config from "config";
import { MAX_ACCEPTED_FEE, MAX_ACCEPTED_FEE_PER_BYTE, MIN_CHANNEL_SIZE_SAT } from "../../../utils/constants";

export function checkFeeTooHigh(feerateSatPerByte: Long, feeSat: Long) {
  return feerateSatPerByte.greaterThanOrEqual(MAX_ACCEPTED_FEE_PER_BYTE) || feeSat.greaterThan(MAX_ACCEPTED_FEE);
}

export function getMinimumPaymentSat(feeEstimateSat: Long) {
  return Math.max(
    feeEstimateSat.mul(5).toNumber(),
    MIN_CHANNEL_SIZE_SAT, // lnd minchansize
  );
}

export function getMaximumPaymentSat() {
  return config.get<number>("maximumPaymentSat");
}
