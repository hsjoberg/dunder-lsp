import { Client } from "@grpc/grpc-js";
import {
  IChannelRequestDB,
  checkAllHtclSettlementsSettled,
  countOpenChannelRequests,
  createChannelRequest,
  createHtlcSettlements,
  deleteFailedHtlcSettlement,
  getChannelRequest,
  getHtlcSettlementByCircuitKey,
  hasHtlcSettlements,
  markHtlcSettlementSettled,
} from "../../../db/ondemand-channel";
import {
  bytesToHexString,
  generateShortChannelId,
  hexToUint8Array,
  sha256,
} from "../../../utils/common";
import {
  checkFeeTooHigh,
  getFeeChargeSat,
  getMaximumPaymentSat,
  getMinimumPaymentSat,
  isChannelOpeningEnabled,
} from "./utils";
import {
  checkPeerConnected,
  checkPeerConnectedRecent,
  estimateFee,
  getInfo,
  listChannels,
  listChannelsRecent,
  subscribeHtlcEvents,
} from "../../../utils/lnd-api";
import { handled, HtlcHandler, HtlcResponseWriter, noDecision } from "../../htlc-interceptor";
import { getUnixTime } from "date-fns";
import { lnrpc, routerrpc } from "../../../proto";

import { Database } from "sqlite";
import { IErrorResponse } from "../index";
import Long from "long";
import { RouteHandlerMethod } from "fastify";
import config from "config";
import { openChannelForSettledHtlcs } from "../channel-open";
import { parseSignedEnvelope, verifySignedEnvelope } from "./signed-request";
import { subscribeWithReconnect } from "../../../utils/reconnecting-stream";
import { FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY } from "../settlement-deadline";

export interface IRegisterRequest {
  pubkey: string;
  signature: string; // Legacy scheme: the message is "REGISTER". See signed-request.ts.
  preimage: string;
  amountSat: number;
}

export interface IRegisterOkResponse {
  status: "OK";
  servicePubkey: string;
  fakeChannelId: string; // TODO make these as an array of route hints instead
  cltvExpiryDelta: number;
  feeBaseMsat: number;
  feeProportionalMillionths: number;
}

const REGISTER_ENDPOINT = "/ondemand-channel/register";

/** Seconds a registered request accepts payments. Blixt's invoice expiry is also 600s. */
export const REQUEST_EXPIRY_SECONDS = 600;

/**
 * Extra seconds after expiry during which the first part of a payment is still
 * accepted. Blixt creates its invoice (with its own 600s expiry, on the phone's
 * clock) only after /register returns, so the invoice outlives the request by
 * a few seconds plus any clock difference.
 */
export const REQUEST_EXPIRY_GRACE_SECONDS = 120;

const DEFAULT_MAX_OPEN_REQUESTS_PER_PUBKEY = 5;

const MSAT_PER_SAT = BigInt(1000);

export function isValidPreimageHex(preimage: unknown): preimage is string {
  return typeof preimage === "string" && /^[0-9a-fA-F]{64}$/.test(preimage);
}

/**
 * Validates the request fields of a register request.
 *
 * The preimage is later sent to lnd in a SETTLE action. lnd rejects a preimage
 * that is not exactly 32 bytes and drops the whole interceptor stream when it
 * does, so this must be enforced before anything is stored.
 */
export function parseRegisterFields(
  data: Record<string, unknown>,
): { preimage: string; amountSat: number } | null {
  const { preimage, amountSat } = data;
  if (
    !isValidPreimageHex(preimage) ||
    typeof amountSat !== "number" ||
    !Number.isSafeInteger(amountSat) ||
    amountSat <= 0
  ) {
    return null;
  }
  // Normalise the hex so the UNIQUE constraint also catches case variants.
  return { preimage: preimage.toLowerCase(), amountSat };
}

function getMaxOpenRequestsPerPubkey() {
  return config.has("maxOpenRequestsPerPubkey")
    ? config.get<number>("maxOpenRequestsPerPubkey")
    : DEFAULT_MAX_OPEN_REQUESTS_PER_PUBKEY;
}

/**
 * How long the parts of one payment are held while waiting for the rest.
 * The old config key `htlcWaitMs` was always used as seconds despite its name.
 */
export function getHtlcWaitSeconds() {
  if (config.has("htlcWaitSeconds")) {
    return config.get<number>("htlcWaitSeconds");
  }
  if (config.has("htlcWaitMs")) {
    return config.get<number>("htlcWaitMs");
  }
  return 60;
}

function errorResponse(reason: string): IErrorResponse {
  return { status: "ERROR", reason };
}

export default function Register(
  db: Database,
  lightning: Client,
  _router: Client,
  servicePubkey: string,
): RouteHandlerMethod {
  return async (request, reply) => {
    if (!isChannelOpeningEnabled()) {
      reply.code(503);
      return errorResponse("Dunder is currently not accepting new channel requests.");
    }

    const envelope = parseSignedEnvelope(request.body, REGISTER_ENDPOINT, "REGISTER");
    if (!envelope.ok) {
      reply.code(400);
      return errorResponse(envelope.reason);
    }
    const fields = parseRegisterFields(envelope.value.data);
    if (!fields) {
      reply.code(400);
      return errorResponse(
        "Invalid request. The preimage must be 32 bytes encoded as hex and " +
          "amountSat must be a positive integer.",
      );
    }

    const verified = await verifySignedEnvelope(lightning, envelope.value);
    if (!verified.ok) {
      reply.code(verified.statusCode ?? 400);
      return errorResponse(verified.reason);
    }
    const pubkey = verified.value;

    const openRequests = await countOpenChannelRequests(
      db,
      pubkey,
      getUnixTime(new Date()),
      REQUEST_EXPIRY_GRACE_SECONDS,
    );
    if (openRequests >= getMaxOpenRequestsPerPubkey()) {
      reply.code(429);
      return errorResponse(
        "Too many unpaid requests. Pay or wait for an earlier invoice to expire first.",
      );
    }

    // The maximum payment we'll accept
    const maximumPaymentSat = getMaximumPaymentSat();
    if (fields.amountSat > maximumPaymentSat) {
      reply.code(400);
      return errorResponse(
        `The requested invoice is above the maximum limit of ${maximumPaymentSat} satoshi`,
      );
    }

    // Check if onchain fee is too high.
    // Dunder will cease to operate once the fees reach a certain threshold.
    let estimateFeeResponse: lnrpc.EstimateFeeResponse;
    try {
      estimateFeeResponse = await estimateFee(lightning, Long.fromValue(maximumPaymentSat), 1);
    } catch (e) {
      // If we don't have enough funds we'll get here
      reply.code(503);
      return errorResponse("Dunder is temporarily offline.");
    }

    const feesTooHigh = checkFeeTooHigh(
      estimateFeeResponse.feerateSatPerByte,
      estimateFeeResponse.feeSat,
    );
    if (feesTooHigh) {
      reply.code(503);
      return errorResponse(
        "Dunder is currently not available because Bitcoin onchain fees are too high.",
      );
    }

    // The minimum payment we'll accept.
    // Configurable via the `minimumPaymentMultiplier`.
    // As the user will have to pay the on-chain transaction cost, we require the payment to be
    // received has to be higher than current on-chain tx fee times a multiplier.
    //
    // A channel opening can also not be lower than the default minimum requirement by lnd.
    const minimumPaymentSat = getMinimumPaymentSat(estimateFeeResponse.feeSat);
    if (fields.amountSat < minimumPaymentSat) {
      reply.code(400);
      return errorResponse(
        `The requested invoice is below the minimum requirement of ${minimumPaymentSat.toString()} satoshi`,
      );
    }

    // Check if the requester is connected to our Lightning node
    // If not we'll immediately fail.
    if (!(await checkPeerConnected(lightning, pubkey))) {
      reply.code(400);
      return errorResponse("Wallet is not connected to Dunder's Lightning node.");
    }

    // Generate a channelId and register the channel request to the database.
    // We will use this database entry later on to check incoming HTLCs.
    const channelId = await (async function generateShortId(): Promise<Long> {
      const shortId = Long.fromValue(await generateShortChannelId());

      // lnd reads a next channel of 0 as "the payment ends here", so an HTLC
      // for it would never reach the interceptor.
      if (shortId.isZero() || (await getChannelRequest(db, shortId.toString()))) {
        console.log("Short id exists. Trying again");
        return await generateShortId();
      }
      return shortId;
    })();

    await createChannelRequest(db, {
      channelId: channelId.toString(),
      pubkey,
      preimage: fields.preimage,
      status: "REGISTERED",
      start: getUnixTime(new Date()),
      expire: REQUEST_EXPIRY_SECONDS,
      expectedAmountSat: fields.amountSat,
      channelPoint: null,
    });

    const response: IRegisterOkResponse = {
      status: "OK",
      servicePubkey,
      fakeChannelId: channelId.toString(10),
      cltvExpiryDelta: 40,
      feeBaseMsat: 1,
      feeProportionalMillionths: 1,
    };
    console.log("New request, channelId =", channelId.toString(10));
    return response;
  };
}

/*
 * Holding the parts of a payment
 * ------------------------------
 * BOLT#4 multi-part payments must be settled all at once, when the parts add
 * up to the expected amount. The parts are held in memory, keyed by request
 * (fake channel ID) and by lnd's incoming circuit key, so that an HTLC lnd
 * sends again (it replays held HTLCs on a new interceptor stream) replaces its
 * entry instead of being counted twice.
 *
 * Every held part gets exactly one answer:
 *   - FAIL when the payment can't complete (timeout, overshoot, fees, ...)
 *   - SETTLE once every part has been recorded in the database
 * After SETTLE the database rows are the source of truth; an HTLC that shows
 * up again is answered with SETTLE again.
 */

type HeldPart = {
  incomingCircuitKey: routerrpc.ICircuitKey;
  incomingChannelId: string;
  htlcId: string;
  amountMsat: bigint;
  incomingAmountMsat: bigint;
  incomingExpiry: number;
  /** The incoming channel when the part arrived (unknown if lnd didn't list it). */
  incomingChannelPoint?: string;
  writer: HtlcResponseWriter;
};

type HeldPayment = {
  channelId: string;
  lightning: Client;
  parts: Map<string, HeldPart>;
  state: "COLLECTING" | "SETTLING";
  settleSent: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const heldPayments = new Map<string, HeldPayment>();

/**
 * Interceptor stream resets so far. A handler that started before a reset
 * answers on the old stream, which is gone: lnd has released its HTLC (or
 * offers it again on the new stream), so the handler must not count it.
 */
let streamResets = 0;

/**
 * How long a settled payment stays in `heldPayments`. An HTLC offer for one of
 * its parts (lnd's single on-chain offer, for example) can be checked against
 * the database just before the parts are recorded and reach the held payment
 * only after; while it stays here, the handler answers that offer SETTLE.
 */
export const SETTLED_PAYMENT_KEEP_MS = 60_000;

function totalMsat(payment: HeldPayment) {
  let total = BigInt(0);
  for (const part of payment.parts.values()) {
    total += part.amountMsat;
  }
  return total;
}

function failHeldPayment(payment: HeldPayment, reason: string) {
  console.warn("Failing held payment", {
    channelId: payment.channelId,
    parts: payment.parts.size,
    reason,
  });
  clearTimeout(payment.timer);
  if (heldPayments.get(payment.channelId) === payment) {
    heldPayments.delete(payment.channelId);
  }
  answerHeldParts(
    payment.lightning,
    [...payment.parts.values()],
    routerrpc.ResolveHoldForwardAction.FAIL,
  ).catch((error) => console.error("Could not answer held parts", error));
}

/** The channel point of the open channel with this ID (or alias ID), if any. */
async function findOpenChannel(lightning: Client, chanId: string) {
  try {
    return (
      findChannel(await listChannelsRecent(lightning), chanId) ??
      // Not in the shared list: a channel opened within the last second (or
      // one that just closed). Parts only arrive over real channels, so this
      // extra call can't be triggered at will the way unknown IDs could.
      findChannel(await listChannels(lightning), chanId)
    );
  } catch (error) {
    console.error("Could not list channels", error);
  }
  return undefined;
}

function findChannel({ channels }: lnrpc.ListChannelsResponse, chanId: string) {
  for (const channel of channels as lnrpc.Channel[]) {
    const ids = [channel.chanId, channel.zeroConfConfirmedScid, ...(channel.aliasScids ?? [])];
    if (ids.some((id) => id && id.toString() === chanId)) {
      return {
        channelPoint: channel.channelPoint,
        dustLimitSat: BigInt(channel.localConstraints?.dustLimitSat?.toString() ?? "0"),
      };
    }
  }
  return undefined;
}

/**
 * Answers held parts. A part whose incoming channel has closed while it was
 * held is left unanswered: lnd ends the interceptor stream over an answer to
 * it ("edge not found"), and offers the HTLC again as an on-chain HTLC, which
 * Dunder answers then (SETTLE if it was recorded, nothing otherwise).
 */
async function answerHeldParts(
  lightning: Client,
  parts: HeldPart[],
  action: routerrpc.ResolveHoldForwardAction,
  preimage?: Uint8Array,
) {
  let openChannelPoints: Set<string> | null = null;
  if (parts.some((part) => part.incomingChannelPoint && !part.writer.onChain)) {
    try {
      const { channels } = await listChannels(lightning);
      openChannelPoints = new Set(channels.map((channel) => channel.channelPoint ?? ""));
    } catch (error) {
      console.error("Could not list channels; answering held parts anyway", error);
    }
  }
  for (const part of parts) {
    if (
      openChannelPoints &&
      part.incomingChannelPoint &&
      !part.writer.onChain &&
      !openChannelPoints.has(part.incomingChannelPoint)
    ) {
      console.warn("Not answering a held part whose channel has closed; lnd offers it on-chain", {
        action: routerrpc.ResolveHoldForwardAction[action],
        incomingChannelId: part.incomingChannelId,
        htlcId: part.htlcId,
      });
      continue;
    }
    part.writer.respond(action, part.incomingCircuitKey, preimage);
  }
}

/**
 * The interceptor stream went away. lnd released the HTLCs it held (or will
 * replay them on the next stream), so payments that are still being collected
 * must not keep counting those parts. Payments already being settled finish
 * on their own: their parts are recorded in the database first, and a replayed
 * part is answered from there.
 */
export function dropHeldPaymentsAfterStreamReset() {
  streamResets += 1;
  for (const [channelId, payment] of heldPayments) {
    if (payment.state === "COLLECTING") {
      clearTimeout(payment.timer);
      heldPayments.delete(channelId);
    }
  }
}

/**
 * lnd fails a held HTLC by itself when a new block reaches the HTLC's
 * auto-fail height (incoming expiry minus 13 blocks). If Dunder answers that
 * HTLC afterwards, lnd can't find it and ends the interceptor stream. Parts are
 * therefore only held when at least this many blocks remain before that height,
 * enough for the hold (`htlcWaitSeconds`) plus a slightly stale block height.
 * Honest payments have far more room: Dunder's route hint alone adds 40 blocks.
 */
export const MIN_BLOCKS_BEFORE_AUTO_FAIL = 6;
/**
 * lnd limits how far ahead a forwarded HTLC may expire only on the outgoing
 * channel, and the fake channel ID has none. A part expiring far ahead could
 * stall its request's payout until then. Payers' lnd refuses routes longer
 * than 2016 blocks by default.
 */
export const MAX_BLOCKS_UNTIL_EXPIRY = 2016;
/**
 * The deadline guard force-closes the incoming channel when a settled part is
 * still pending this close to its expiry. Holding parts only well before that
 * point leaves an honest peer plenty of blocks to lock the settlement in, even
 * when blocks come during the hold. Honest payments arrive with at least the
 * route hint's 40 blocks plus the invoice's final delta.
 */
export const MIN_BLOCKS_UNTIL_EXPIRY = FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY + 18;
const LND_CLTV_REJECT_DELTA = 13;
const BLOCK_HEIGHT_CACHE_MS = 15_000;

let blockHeightCache: { expiresAt: number; height: Promise<number> } | null = null;

function getCurrentBlockHeight(lightning: Client) {
  const now = Date.now();
  if (!blockHeightCache || blockHeightCache.expiresAt <= now) {
    const height = getInfo(lightning).then((info) => info.blockHeight);
    blockHeightCache = { expiresAt: now + BLOCK_HEIGHT_CACHE_MS, height };
    height.catch(() => {
      blockHeightCache = null;
    });
  }
  return blockHeightCache.height;
}

/** Why an HTLC's expiry rules out holding it, or null when it is fine. */
async function checkHtlcExpiry(
  lightning: Client,
  request: routerrpc.ForwardHtlcInterceptRequest,
): Promise<string | null> {
  const autoFailHeight =
    request.autoFailHeight > 0
      ? request.autoFailHeight
      : request.incomingExpiry - LND_CLTV_REJECT_DELTA;
  let currentHeight: number;
  try {
    currentHeight = await getCurrentBlockHeight(lightning);
  } catch (error) {
    // Without a height the margin can't be checked; the payer can retry.
    console.error("Could not get the block height for the HTLC expiry check", error);
    return "Could not check the HTLC's expiry";
  }
  if (
    autoFailHeight - currentHeight <= MIN_BLOCKS_BEFORE_AUTO_FAIL ||
    request.incomingExpiry - currentHeight < MIN_BLOCKS_UNTIL_EXPIRY
  ) {
    return "HTLC expires too soon to be held";
  }
  if (request.incomingExpiry - currentHeight > MAX_BLOCKS_UNTIL_EXPIRY) {
    return "HTLC expires too far ahead";
  }
  return null;
}

function isRequestExpired(channelRequest: IChannelRequestDB, nowUnix: number) {
  return nowUnix > channelRequest.start + channelRequest.expire + REQUEST_EXPIRY_GRACE_SECONDS;
}

/**
 * Intercepts HTLCs addressed to a fake channel ID handed out by /register.
 */
export const createOnDemandChannelHtlcHandler = (
  db: Database,
  lightning: Client,
): HtlcHandler => async (request, writer) => {
  const resetsAtStart = streamResets;
  const channelId = request.outgoingRequestedChanId.toString();
  const channelRequest = await getChannelRequest(db, channelId);
  if (!channelRequest) {
    return noDecision();
  }

  const incomingChannelId = request.incomingCircuitKey?.chanId?.toString() ?? "0";
  const htlcId = request.incomingCircuitKey?.htlcId?.toString() ?? "0";
  const circuitKey = `${incomingChannelId}:${htlcId}`;
  const amountMsat = BigInt(request.outgoingAmountMsat.toString());
  const incomingAmountMsat = BigInt(request.incomingAmountMsat.toString());

  console.log("Intercepted HTLC for on-demand channel", {
    channelId,
    circuitKey,
    amountMsat: amountMsat.toString(),
    incomingAmountMsat: incomingAmountMsat.toString(),
    outgoingExpiry: request.outgoingExpiry,
  });

  // Always fails with lnd's default code (TEMPORARY_CHANNEL_FAILURE). lnd's
  // interceptor rejects most other codes, including
  // INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS, and ends the whole stream when it does.
  const fail = (reason: string) => {
    console.warn("Failing HTLC", { channelId, circuitKey, reason });
    writer.respond(routerrpc.ResolveHoldForwardAction.FAIL, request.incomingCircuitKey);
    return handled();
  };

  // For HTLCs the request can never accept, follow LSPS2 (bLIP-52) and fail
  // with unknown_next_peer. lnd's interceptor can't send that code, but on
  // RESUME lnd tries to forward to the fake channel ID, which doesn't exist,
  // and fails the HTLC with unknown_next_peer itself.
  const failAsUnknownChannel = (reason: string) => {
    console.warn("Failing HTLC as unknown channel", { channelId, circuitKey, reason });
    writer.respond(routerrpc.ResolveHoldForwardAction.RESUME, request.incomingCircuitKey);
    return handled();
  };

  // The outgoing amount comes from the payer's onion; only the incoming amount
  // was actually received. lnd checks incoming >= outgoing + fee on the
  // outgoing channel, but the fake channel ID has none, so an intercepted HTLC
  // reaches us unchecked. Without this, a payer could send 1 sat with an onion
  // that says to forward the full amount, and Dunder would pay out the full
  // amount. Honest payments carry at least the outgoing amount (the route
  // hint's fee comes on top).
  if (incomingAmountMsat < amountMsat) {
    return fail("Incoming amount is below the amount to forward");
  }

  // Requests stored before preimage validation existed may hold a preimage lnd
  // would reject; never send it in a SETTLE action.
  if (
    !isValidPreimageHex(channelRequest.preimage) ||
    bytesToHexString(request.paymentHash) !== sha256(hexToUint8Array(channelRequest.preimage))
  ) {
    return fail("Payment hash does not match");
  }
  const preimage = hexToUint8Array(channelRequest.preimage);

  // An HTLC we already decided to settle (lnd replays held HTLCs, for example
  // after a reconnect). Answer with the same decision.
  const recorded = await getHtlcSettlementByCircuitKey(db, incomingChannelId, htlcId);
  if (recorded) {
    if (recorded.channelId !== channelId) {
      return fail("Circuit key is recorded for a different request");
    }
    if (writer.onChain) {
      // The payer has the preimage but never locked the settlement in, and its
      // channel is now on-chain: a broken peer, or a payer trying to take the
      // HTLC back after Dunder settled it. SETTLE gives lnd the preimage so it
      // claims the HTLC on-chain; the payout waits for lnd's final outcome.
      console.error("A settled HTLC came back on-chain; settling it so lnd claims it", {
        channelId,
        circuitKey,
        amountMsat: amountMsat.toString(),
        incomingExpiry: request.incomingExpiry,
      });
    } else {
      console.warn("HTLC was already recorded for settlement, settling it again", {
        channelId,
        circuitKey,
      });
    }
    writer.respond(routerrpc.ResolveHoldForwardAction.SETTLE, request.incomingCircuitKey, preimage);
    return handled();
  }

  // Never settle a new payment while channel opening is disabled: the payer
  // would be charged for a channel that will not open. (HTLCs already recorded
  // for settlement are answered above; failing one of those could leave a
  // payment partly settled.)
  if (!isChannelOpeningEnabled()) {
    const payment = heldPayments.get(channelId);
    if (payment && payment.state === "COLLECTING") {
      failHeldPayment(payment, "Channel opening is disabled");
    }
    return fail("Channel opening is disabled");
  }

  const alreadyPaid = await hasHtlcSettlements(db, channelId);
  const peerConnected = await checkPeerConnectedRecent(lightning, channelRequest.pubkey);
  const expiryProblem = await checkHtlcExpiry(lightning, request);
  // An on-chain offer's channel has closed, so it is never in the list.
  const incomingChannel = writer.onChain
    ? undefined
    : await findOpenChannel(lightning, incomingChannelId);
  const incomingChannelPoint = incomingChannel?.channelPoint;

  // Everything below runs without awaiting, so the held payment can't change
  // underneath it.
  if (streamResets !== resetsAtStart) {
    console.warn("Interceptor stream reset while handling an HTLC; dropping it", {
      channelId,
      circuitKey,
    });
    return handled();
  }
  let payment = heldPayments.get(channelId);

  const knownPart = payment?.parts.get(circuitKey);
  if (payment && knownPart) {
    if (payment.settleSent) {
      writer.respond(routerrpc.ResolveHoldForwardAction.SETTLE, request.incomingCircuitKey, preimage);
    } else {
      // Same HTLC on a new interceptor stream: answer it on the live stream.
      knownPart.writer = writer;
    }
    return handled();
  }

  if (channelRequest.status !== "REGISTERED") {
    return failAsUnknownChannel(`Request is ${channelRequest.status}`);
  }
  if (alreadyPaid) {
    return failAsUnknownChannel("Request has already been paid");
  }
  if (payment?.state === "SETTLING") {
    return failAsUnknownChannel("Payment is already being settled");
  }
  if (!payment && isRequestExpired(channelRequest, getUnixTime(new Date()))) {
    return failAsUnknownChannel("Request has expired");
  }
  // TODO(hsjoberg): maybe this is too harsh
  if (!peerConnected) {
    return fail("Wallet node not connected");
  }
  if (expiryProblem) {
    return fail(expiryProblem);
  }
  // A dust part has no output on Dunder's commitment, so it can't be claimed
  // on-chain if the payer stalls it after Dunder settled, and the deadline
  // guard skips it, leaving the whole request unpaid. Honest payments don't
  // split this small.
  if (incomingChannel && incomingAmountMsat < incomingChannel.dustLimitSat * MSAT_PER_SAT) {
    return fail("Part is below the incoming channel's dust limit");
  }

  const expectedMsat = BigInt(channelRequest.expectedAmountSat) * MSAT_PER_SAT;
  const currentMsat = payment ? totalMsat(payment) : BigInt(0);
  if (currentMsat + amountMsat > expectedMsat) {
    return failAsUnknownChannel("Part would exceed the expected amount");
  }

  if (!payment) {
    const newPayment: HeldPayment = {
      channelId,
      lightning,
      parts: new Map(),
      state: "COLLECTING",
      settleSent: false,
      timer: setTimeout(() => {
        if (heldPayments.get(channelId) === newPayment && newPayment.state === "COLLECTING") {
          failHeldPayment(newPayment, "Timed out waiting for the remaining parts");
        }
      }, getHtlcWaitSeconds() * 1000),
    };
    newPayment.timer.unref?.();
    heldPayments.set(channelId, newPayment);
    payment = newPayment;
  }

  payment.parts.set(circuitKey, {
    incomingCircuitKey: request.incomingCircuitKey!,
    incomingChannelId,
    htlcId,
    amountMsat,
    incomingAmountMsat,
    incomingExpiry: request.incomingExpiry,
    incomingChannelPoint,
    writer,
  });

  const total = totalMsat(payment);
  console.log("Held payment", {
    channelId,
    totalMsat: total.toString(),
    expectedMsat: expectedMsat.toString(),
  });

  if (total === expectedMsat) {
    payment.state = "SETTLING";
    clearTimeout(payment.timer);
    settleHeldPayment(db, lightning, channelRequest, payment, preimage).catch((error) => {
      console.error("Unexpected error while settling held payment", error);
    });
  }

  return handled();
};

async function settleHeldPayment(
  db: Database,
  lightning: Client,
  channelRequest: IChannelRequestDB,
  payment: HeldPayment,
  preimage: Uint8Array,
) {
  if (!isChannelOpeningEnabled()) {
    // Disabled while the parts were being collected.
    failHeldPayment(payment, "Channel opening is disabled");
    return;
  }

  const maximumPaymentSat = getMaximumPaymentSat();
  const total = totalMsat(payment);

  // Known limitation: this checks only whether the fee leaves a positive
  // push amount. If the estimate now exceeds Dunder's configured ceiling, the
  // payment is still settled and channel opening is deferred until fees fall
  // below that ceiling.
  try {
    const feeResult = await estimateFee(lightning, Long.fromValue(maximumPaymentSat), 1);
    const feeChargeMsat = BigInt(getFeeChargeSat(feeResult.feeSat)) * MSAT_PER_SAT;
    if (total - feeChargeMsat <= BigInt(0)) {
      failHeldPayment(payment, "On-chain fee is higher than the payment");
      return;
    }
  } catch (error) {
    console.error("estimateFee failed", error);
    failHeldPayment(payment, "Could not estimate the on-chain fee");
    return;
  }

  const parts = [...payment.parts.values()];
  try {
    // The handler's "already paid" check ran before its awaits. Another payment
    // for this request may have been recorded since: a new held payment only
    // starts after the previous one removed its entry, which happens after its
    // rows were written, so checking again here always sees them.
    if (await hasHtlcSettlements(db, payment.channelId)) {
      failHeldPayment(payment, "Request has already been paid");
      return;
    }
    // Record every part before revealing the preimage. A settled HTLC must
    // never exist without its row, or the recipient could not be paid out.
    await createHtlcSettlements(
      db,
      parts.map((part) => ({
        channelId: payment.channelId,
        incomingChannelId: part.incomingChannelId,
        htlcId: part.htlcId,
        amountSat: Number(part.amountMsat / MSAT_PER_SAT),
        amountMsat: part.amountMsat.toString(),
        incomingAmountMsat: part.incomingAmountMsat.toString(),
        incomingExpiry: part.incomingExpiry,
        incomingChannelPoint: part.incomingChannelPoint ?? null,
        settled: 0,
        claimed: 0,
      })),
    );
  } catch (error) {
    console.error("Could not record HTLC settlements", error);
    failHeldPayment(payment, "Could not record the payment");
    return;
  }

  payment.settleSent = true;
  payment.timer = setTimeout(() => {
    if (heldPayments.get(payment.channelId) === payment) {
      heldPayments.delete(payment.channelId);
    }
  }, SETTLED_PAYMENT_KEEP_MS);
  payment.timer.unref?.();
  console.log("Settling parts", {
    channelId: payment.channelId,
    parts: parts.map((part) => `${part.incomingChannelId}:${part.htlcId}`),
  });
  await answerHeldParts(lightning, parts, routerrpc.ResolveHoldForwardAction.SETTLE, preimage);
  console.log("Waiting for lnd to confirm the settlement", {
    channelId: channelRequest.channelId,
  });
}

/*
 * Tracking settlements
 * --------------------
 * lnd reports each HTLC's outcome on SubscribeHtlcEvents. A settled HTLC marks
 * its row as settled; once every part of a request is settled, the channel is
 * opened. An HTLC that lnd failed back instead (for example because it was
 * released while the interceptor was disconnected) never paid us, so its row
 * is removed. The recovery loop also opens channels for fully settled
 * requests, in case an event was missed.
 */

const automaticOpensInFlight = new Set<string>();

async function openChannelForSettledRequest(db: Database, lightning: Client, channelId: string) {
  if (automaticOpensInFlight.has(channelId)) {
    return;
  }
  automaticOpensInFlight.add(channelId);
  try {
    const channelRequest = await getChannelRequest(db, channelId);
    if (!channelRequest || channelRequest.status !== "REGISTERED") {
      return;
    }
    console.log("Opening channel", { pubkey: channelRequest.pubkey, channelId });
    const result = await openChannelForSettledHtlcs({
      db,
      lightning,
      pubkey: channelRequest.pubkey,
      source: "AUTOMATIC",
      requestedChannelId: channelId,
      requiredAmountSat: channelRequest.expectedAmountSat,
      zeroConf: config.get<boolean>("allowZeroConfChannels") || false,
      taprootChannel: config.get<boolean>("allowTaprootChannels") || false,
    });
    if (result.status !== "OPENED") {
      console.warn("Automatic channel open did not complete", {
        channelId,
        status: result.status,
      });
    }
  } catch (error) {
    console.error("Could not open channel", error);
  } finally {
    automaticOpensInFlight.delete(channelId);
  }
}

export async function handleHtlcSettled(
  db: Database,
  lightning: Client,
  incomingChannelId: string,
  htlcId: string,
) {
  const newlySettled = await markHtlcSettlementSettled(db, incomingChannelId, htlcId);
  if (!newlySettled) {
    return;
  }
  const settlement = await getHtlcSettlementByCircuitKey(db, incomingChannelId, htlcId);
  if (!settlement) {
    return;
  }
  console.log("HTLC settled", { channelId: settlement.channelId, incomingChannelId, htlcId });
  if (await checkAllHtclSettlementsSettled(db, settlement.channelId)) {
    await openChannelForSettledRequest(db, lightning, settlement.channelId);
  }
}

export async function handleHtlcFailed(db: Database, incomingChannelId: string, htlcId: string) {
  const settlement = await getHtlcSettlementByCircuitKey(db, incomingChannelId, htlcId);
  if (!settlement || settlement.settled === 1) {
    return;
  }
  if (await deleteFailedHtlcSettlement(db, incomingChannelId, htlcId)) {
    console.error("lnd failed an HTLC that Dunder had decided to settle; removed its record", {
      channelId: settlement.channelId,
      incomingChannelId,
      htlcId,
    });
  }
}

export function startHtlcSettlementTracking(db: Database, lightning: Client, router: Client) {
  return subscribeWithReconnect(
    () => subscribeHtlcEvents(router),
    async (data) => {
      const htlcEvent = routerrpc.HtlcEvent.decode(data);
      const incomingChannelId = htlcEvent.incomingChannelId.toString();
      const htlcId = htlcEvent.incomingHtlcId.toString();

      // Only lnd's final outcome counts. The settle event comes as soon as lnd
      // has *sent* the preimage, before the payer has locked the settlement
      // in; a payer that stops responding then can still take the HTLC back
      // on-chain after it expires. The final event comes once the payer has
      // revoked its old commitment, or once lnd has claimed the HTLC on-chain.
      if (htlcEvent.finalHtlcEvent?.settled === true) {
        await handleHtlcSettled(db, lightning, incomingChannelId, htlcId);
      } else if (htlcEvent.finalHtlcEvent && htlcEvent.finalHtlcEvent.settled === false) {
        await handleHtlcFailed(db, incomingChannelId, htlcId);
      }
    },
    { name: "SubscribeHtlcEvents" },
  );
}
