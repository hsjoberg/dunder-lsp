import Long from "long";
import config from "config";

export function checkFeeTooHigh(feerateSatPerByte: Long, feeSat: Long) {
  const maxSat = config.get<number>("fee.maxSat");
  const maxSatPerVByte = config.get<number>("fee.maxSatPerVByte");
  return feerateSatPerByte.greaterThan(maxSatPerVByte) || feeSat.greaterThan(maxSat);
}

export function getMinimumPaymentSat(feeEstimateSat: Long) {
  const feeSubsidyFactor = config.get<number>("fee.subsidyFactor");

  return feeEstimateSat
    .div(1 / feeSubsidyFactor)
    .mul(5)
    .toNumber();
}

export function getMaximumPaymentSat() {
  return config.get<number>("maximumPaymentSat");
}
