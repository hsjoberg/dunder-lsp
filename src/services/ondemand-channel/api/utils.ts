import Long from "long";
import config from "config";
import { MIN_CHANNEL_SIZE_SAT } from "../../../utils/constants";

export function checkFeeTooHigh(feerateSatPerByte: Long, feeSat: Long) {
  return feerateSatPerByte.greaterThanOrEqual(200) || feeSat.greaterThan(33140);
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
