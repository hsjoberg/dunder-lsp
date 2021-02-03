import Long from "long";

export function checkFeeTooHigh(feerateSatPerByte: Long, feeSat: Long) {
  return feerateSatPerByte.greaterThanOrEqual(200) || feeSat.greaterThan(33140);
}

export function getMinimumPaymentSat(feeEstimateSat: Long) {
  return feeEstimateSat.mul(5);
}
