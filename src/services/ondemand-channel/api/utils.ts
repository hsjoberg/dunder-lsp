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

/**
 * `channelOpeningEnabled` is an operator kill switch. It defaults to true so
 * existing configurations keep working. When false, Dunder accepts no new
 * channel requests, refuses incoming payments for existing ones and never
 * dispatches a new channel open. Reconciliation of opens that were already
 * dispatched to lnd keeps running.
 */
export function isChannelOpeningEnabled() {
  if (!config.has("channelOpeningEnabled")) {
    return true;
  }
  const enabled = config.get<unknown>("channelOpeningEnabled");
  if (typeof enabled !== "boolean") {
    throw new Error("channelOpeningEnabled must be a boolean");
  }
  return enabled;
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
