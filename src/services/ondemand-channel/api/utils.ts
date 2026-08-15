import Long from "long";
import config from "config";

export function checkFeeTooHigh(feerateSatPerByte: Long, feeSat: Long) {
  const maxSat = config.get<number>("fee.maxSat");
  const maxSatPerVByte = config.get<number>("fee.maxSatPerVByte");
  return feerateSatPerByte.greaterThan(maxSatPerVByte) || feeSat.greaterThan(maxSat);
}

export function getMinimumPaymentSat(feeEstimateSat: Long) {
  const minimumPaymentMultiplier = config.get<number>("minimumPaymentMultiplier");
  if (!Number.isFinite(minimumPaymentMultiplier) || minimumPaymentMultiplier <= 0) {
    throw new Error("minimumPaymentMultiplier must be greater than zero");
  }

  const feeChargeSat = getFeeChargeSat(feeEstimateSat);

  // A payment equal to the charged fee would reserve successfully only to
  // produce a zero-satoshi push. Always advertise at least one satoshi more
  // than the fee, even when the configured multiplier is one or lower.
  return Math.max(
    Math.ceil(feeChargeSat * minimumPaymentMultiplier),
    feeChargeSat + 1,
  );
}

export function getMaximumPaymentSat() {
  return config.get<number>("maximumPaymentSat");
}

/**
 * subsidyFactor is the portion of the on-chain fee paid by the recipient:
 * 1 charges the full fee, while 0 fully subsidizes it.
 */
export function getFeeChargeSat(feeEstimateSat: Long | number) {
  const feeSubsidyFactor = config.get<number>("fee.subsidyFactor");
  if (
    !Number.isFinite(feeSubsidyFactor) ||
    feeSubsidyFactor < 0 ||
    feeSubsidyFactor > 1
  ) {
    throw new Error("fee.subsidyFactor must be between zero and one");
  }

  const fee = typeof feeEstimateSat === "number" ? feeEstimateSat : feeEstimateSat.toNumber();
  return Math.floor(fee * feeSubsidyFactor);
}
