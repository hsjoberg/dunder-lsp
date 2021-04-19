import Long from "long";
import config from "config";
import { MIN_CHANNEL_SIZE_SAT } from "../../../utils/constants";

export function checkFeeTooHigh(feerateSatPerByte: Long, feeSat: Long) {
  const maxSat = config.get<number>("fee.maxSat");
  const maxSatPerVByte = config.get<number>("fee.maxSatPerVByte");
  return feerateSatPerByte.greaterThan(maxSatPerVByte) || feeSat.greaterThan(maxSat);
}

export function getMinimumPaymentSat(feeEstimateSat: Long) {
  const feeSubsidyFactor = config.get<number>("fee.subsidyFactor");

  return Math.max(
    feeEstimateSat.mul(feeSubsidyFactor).mul(5).toNumber(),
    MIN_CHANNEL_SIZE_SAT, // lnd minchansize
  );
}

export function getMaximumPaymentSat() {
  return config.get<number>("maximumPaymentSat");
}
