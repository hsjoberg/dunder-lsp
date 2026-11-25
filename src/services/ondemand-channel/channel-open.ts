import { randomUUID } from "crypto";
import { Client } from "@grpc/grpc-js";
import config from "config";
import { Database } from "sqlite";
import Long from "long";

import {
  ChannelOpenAttemptSource,
  IChannelOpenAttemptDB,
  cancelChannelOpenAttempt,
  finalizeChannelOpenAttempt,
  getActiveChannelOpenAttempt,
  getActiveChannelOpenAttempts,
  getChannelOpenAttempt,
  getRecentFailedChannelOpenAttempts,
  getRecoverableAutomaticChannelRequests,
  ChannelOpenFailureKind,
  markChannelOpenAttemptDispatched,
  markChannelOpenAttemptUnknown,
  reserveChannelOpenAttempt,
  touchChannelOpenAttempt,
} from "../../db/channel-open-attempt";
import {
  checkPeerConnected,
  closedChannels,
  estimateFee,
  listChannels,
  lookupHtlcResolution,
  openChannelSync,
  pendingChannels,
  walletBalance,
} from "../../utils/lnd-api";
import {
  deleteFailedHtlcSettlement,
  getUnsettledHtlcSettlements,
  markHtlcSettlementSettled,
} from "../../db/ondemand-channel";
import { bytesToHexString } from "../../utils/common";
import {
  checkFeeTooHigh,
  getFeeChargeSat,
  getMaximumPaymentSat,
  isChannelOpeningEnabled,
} from "./api/utils";

type OpenSettledHtlcsOptions = {
  db: Database;
  lightning: Client;
  pubkey: string;
  source: ChannelOpenAttemptSource;
  requestedChannelId?: string;
  /** The least the selected settlements must add up to (a payment may overshoot). */
  requiredAmountSat?: number;
  zeroConf: boolean;
  taprootChannel: boolean;
};

export type OpenSettledHtlcsResult =
  | { status: "OPENED"; attempt: IChannelOpenAttemptDB }
  | { status: "IN_PROGRESS"; attempt: IChannelOpenAttemptDB }
  | { status: "UNKNOWN"; attempt: IChannelOpenAttemptDB }
  | { status: "CANCELLED"; attempt: IChannelOpenAttemptDB }
  | { status: "NO_SETTLEMENTS" }
  | { status: "AMOUNT_MISMATCH"; amountSat: number }
  | { status: "FEE_EXCEEDS_AMOUNT"; amountSat: number }
  | { status: "FEES_TOO_HIGH" }
  | { status: "PEER_OFFLINE" }
  | { status: "PENDING_CHANNEL" }
  | { status: "INSUFFICIENT_FUNDS" }
  | { status: "DISABLED" }
  | { status: "BACKOFF"; retryAt: number };

type PeerChannelState = {
  channelPoints: string[];
  pendingPeerChannelCount: number;
  observedChannels: { channelPoint: string | null; memo: string }[];
  /** Channels to the peer that are being closed (waiting close or force closing). */
  closingChannelPoints: string[];
};

const CHANNEL_OPEN_MEMO_PREFIX = "dunder-payout:";
const CHANNEL_OPEN_HEARTBEAT_MS = 10_000;
export const CHANNEL_OPEN_ATTEMPT_STALE_MS = 5 * 60 * 1000;

/** Channel size for a payout: every payout channel can receive the maximum payment again. */
export function getChannelCapacitySat(maximumPaymentSat: number) {
  return maximumPaymentSat + 10_000;
}

export function getChannelOpenAttemptMemo(attemptId: string) {
  return `${CHANNEL_OPEN_MEMO_PREFIX}${attemptId}`;
}

async function getPeerChannelState(lightning: Client, pubkey: string): Promise<PeerChannelState> {
  const [channels, pending] = await Promise.all([
    listChannels(lightning),
    pendingChannels(lightning),
  ]);

  const activeChannelPoints = channels.channels
    .filter((channel) => channel.remotePubkey === pubkey && !!channel.channelPoint)
    .map((channel) => channel.channelPoint)
    .filter((channelPoint): channelPoint is string => !!channelPoint);
  const peerPendingChannels = pending.pendingOpenChannels.filter(
    (pendingChannel) => pendingChannel.channel?.remoteNodePub === pubkey,
  );
  const pendingChannelPoints = peerPendingChannels
    .map((pendingChannel) => pendingChannel.channel?.channelPoint)
    .filter((channelPoint): channelPoint is string => !!channelPoint);
  const observedChannels: PeerChannelState["observedChannels"] = [];
  for (const channel of channels.channels) {
    if (channel.remotePubkey === pubkey) {
      observedChannels.push({
        channelPoint: channel.channelPoint || null,
        memo: channel.memo ?? "",
      });
    }
  }
  for (const pendingChannel of peerPendingChannels) {
    const channel = pendingChannel.channel;
    if (channel) {
      observedChannels.push({
        channelPoint: channel.channelPoint || null,
        memo: channel.memo ?? "",
      });
    }
  }

  const closingChannels = [
    ...(pending.waitingCloseChannels ?? []),
    ...(pending.pendingForceClosingChannels ?? []),
  ]
    .map((closing) => closing.channel)
    .filter((channel) => channel?.remoteNodePub === pubkey);
  for (const channel of closingChannels) {
    if (channel) {
      observedChannels.push({
        channelPoint: channel.channelPoint || null,
        memo: channel.memo ?? "",
      });
    }
  }

  return {
    channelPoints: [...new Set([...activeChannelPoints, ...pendingChannelPoints])].sort(),
    pendingPeerChannelCount: peerPendingChannels.length,
    observedChannels,
    closingChannelPoints: closingChannels
      .map((channel) => channel?.channelPoint)
      .filter((channelPoint): channelPoint is string => !!channelPoint),
  };
}

async function getPeerClosedChannelPoints(lightning: Client, pubkey: string) {
  const response = await closedChannels(lightning);
  return [
    ...new Set(
      response.channels
        .filter((channel) => channel.remotePubkey === pubkey)
        .map((channel) => channel.channelPoint)
        .filter((channelPoint): channelPoint is string => !!channelPoint),
    ),
  ].sort();
}

type ReconciliationInspection = {
  finalized: IChannelOpenAttemptDB | null;
  state: PeerChannelState;
  matchingMemoCount: number;
};

async function inspectChannelOpenAttempt(
  db: Database,
  lightning: Client,
  attempt: IChannelOpenAttemptDB,
): Promise<ReconciliationInspection> {
  const state = await getPeerChannelState(lightning, attempt.pubkey);
  const expectedMemo = getChannelOpenAttemptMemo(attempt.attemptId);
  const matchingChannels = state.observedChannels.filter(
    (channel) => channel.memo === expectedMemo,
  );
  const matchingChannelPoints = [
    ...new Set(
      matchingChannels
        .map((channel) => channel.channelPoint)
        .filter((channelPoint): channelPoint is string => !!channelPoint),
    ),
  ];

  // Do not infer ownership merely from a new channel to the same peer. Other
  // operators or processes can open one concurrently. The lnd memo binds the
  // observed channel to this exact durable payout attempt.
  if (matchingChannels.length !== 1 || matchingChannelPoints.length !== 1) {
    return {
      finalized: null,
      state,
      matchingMemoCount: matchingChannels.length,
    };
  }

  return {
    finalized: await finalizeChannelOpenAttempt(db, attempt.attemptId, matchingChannelPoints[0]),
    state,
    matchingMemoCount: matchingChannels.length,
  };
}

async function tryReconcileChannelOpenAttempt(
  db: Database,
  lightning: Client,
  attempt: IChannelOpenAttemptDB,
) {
  return (await inspectChannelOpenAttempt(db, lightning, attempt)).finalized;
}

export async function reconcileChannelOpenAttempt(
  db: Database,
  lightning: Client,
  attempt: IChannelOpenAttemptDB,
  now = Date.now(),
): Promise<OpenSettledHtlcsResult> {
  // A reservation with rpcDispatched=0 is known not to have reached lnd. A
  // fresh one may belong to a live process; a stale one can be released and
  // safely retried without any channel lookup or duplicate-payout risk.
  if (attempt.rpcDispatched === 0) {
    if (now - attempt.updatedAt < CHANNEL_OPEN_ATTEMPT_STALE_MS) {
      return { status: "IN_PROGRESS", attempt };
    }

    try {
      const cancelled = await cancelChannelOpenAttempt(db, attempt.attemptId, {
        reason: "Released stale reservation that was never dispatched to lnd",
        allowDispatched: false,
        expectedUpdatedAt: attempt.updatedAt,
      });
      return { status: "CANCELLED", attempt: cancelled };
    } catch (error) {
      console.warn("Could not release stale pre-dispatch channel-open reservation", {
        attemptId: attempt.attemptId,
        error,
      });
      const current = await getChannelOpenAttempt(db, attempt.attemptId);
      return current?.status === "CANCELLED"
        ? { status: "CANCELLED", attempt: current }
        : { status: "IN_PROGRESS", attempt: current ?? attempt };
    }
  }

  try {
    const finalized = await tryReconcileChannelOpenAttempt(db, lightning, attempt);
    if (finalized) {
      return { status: "OPENED", attempt: finalized };
    }
  } catch (error) {
    console.error("Could not reconcile channel-open attempt", {
      attemptId: attempt.attemptId,
      error,
    });
  }

  // UNKNOWN: OpenChannelSync failed. OPENING with a stale heartbeat: the
  // process that dispatched it died mid-RPC (the heartbeat refreshes
  // updatedAt every few seconds while the RPC is running), so the outcome is
  // unknown. Both are released under the same rules.
  const orphaned =
    attempt.status === "OPENING" && now - attempt.updatedAt >= CHANNEL_OPEN_ATTEMPT_STALE_MS;
  if (attempt.status === "UNKNOWN" || orphaned) {
    try {
      const resolution = await releaseFailedChannelOpenAttempt(
        db,
        lightning,
        attempt,
        now,
        orphaned
          ? "Released after the process opening the channel stopped"
          : "Released after the channel open failed",
      );
      if (resolution.status === "OPENED" || resolution.status === "CANCELLED") {
        return resolution;
      }
    } catch (error) {
      console.error("Could not resolve failed channel-open attempt", {
        attemptId: attempt.attemptId,
        error,
      });
    }
    return attempt.status === "UNKNOWN"
      ? { status: "UNKNOWN", attempt }
      : { status: "IN_PROGRESS", attempt };
  }
  return { status: "IN_PROGRESS", attempt };
}

/** Wait before releasing an attempt lnd explicitly rejected (re-check for a channel). */
export const LND_REJECTED_RELEASE_DELAY_MS = 60 * 1000;
/**
 * Wait before releasing an attempt whose outcome is unknown. lnd (checked in
 * v0.21.8, funding/manager.go `pruneZombieReservations`) fails a funding flow
 * that sees no progress for 10 minutes, swept every minute. An open waits on
 * the peer twice (accept_channel, funding_signed), so lnd gives up within about
 * 22 minutes of the last heartbeat, and OpenChannelSync only returns an error
 * before the channel is persisted and the funding transaction published.
 */
export const AMBIGUOUS_RELEASE_DELAY_MS = 30 * 60 * 1000;

const FAILED_OPEN_BACKOFF_BASE_MS = 5 * 60 * 1000;
const FAILED_OPEN_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const FAILED_OPEN_BACKOFF_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function parseChannelPointList(json: string | null | undefined): Set<string> | null {
  if (json === null || json === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || !parsed.every((point) => typeof point === "string")) {
      return null;
    }
    return new Set<string>(parsed);
  } catch {
    return null;
  }
}

export type FailedAttemptEvidence = {
  matchingMemoCount: number;
  pendingPeerChannelCount: number;
  unidentifiedPeerChannelCount: number;
  newChannelPoints: string[];
  newClosingChannelPoints: string[];
  newClosedChannelPoints: string[];
};

/**
 * Gathers everything that could show lnd funded a channel for this attempt.
 * `evidence` is null when the attempt has no baseline to compare against
 * (attempts reserved before the closed-channel baseline was recorded).
 */
async function collectFailedAttemptEvidence(
  db: Database,
  lightning: Client,
  attempt: IChannelOpenAttemptDB,
): Promise<{ finalized: IChannelOpenAttemptDB | null; evidence: FailedAttemptEvidence | null }> {
  const inspection = await inspectChannelOpenAttempt(db, lightning, attempt);
  if (inspection.finalized) {
    return { finalized: inspection.finalized, evidence: null };
  }

  const openBaseline = parseChannelPointList(attempt.existingChannelPoints);
  const closedBaseline = parseChannelPointList(attempt.existingClosedChannelPoints);
  if (!openBaseline || !closedBaseline) {
    return { finalized: null, evidence: null };
  }

  const closedPoints = await getPeerClosedChannelPoints(lightning, attempt.pubkey);
  return {
    finalized: null,
    evidence: {
      matchingMemoCount: inspection.matchingMemoCount,
      pendingPeerChannelCount: inspection.state.pendingPeerChannelCount,
      unidentifiedPeerChannelCount: inspection.state.observedChannels.filter(
        (channel) => !channel.channelPoint,
      ).length,
      newChannelPoints: inspection.state.channelPoints.filter((point) => !openBaseline.has(point)),
      newClosingChannelPoints: inspection.state.closingChannelPoints.filter(
        (point) => !openBaseline.has(point) && !closedBaseline.has(point),
      ),
      newClosedChannelPoints: closedPoints.filter(
        (point) => !openBaseline.has(point) && !closedBaseline.has(point),
      ),
    },
  };
}

function evidenceIsClean(evidence: FailedAttemptEvidence) {
  return (
    evidence.matchingMemoCount === 0 &&
    evidence.unidentifiedPeerChannelCount === 0 &&
    evidence.newChannelPoints.length === 0 &&
    evidence.newClosingChannelPoints.length === 0 &&
    evidence.newClosedChannelPoints.length === 0
  );
}

export type ReleaseFailedAttemptResult =
  | { status: "OPENED"; attempt: IChannelOpenAttemptDB }
  | { status: "CANCELLED"; attempt: IChannelOpenAttemptDB }
  | { status: "TOO_EARLY"; attempt: IChannelOpenAttemptDB; releasableAt: number }
  | { status: "NO_BASELINE"; attempt: IChannelOpenAttemptDB }
  | {
      status: "EVIDENCE_OF_CHANNEL";
      attempt: IChannelOpenAttemptDB;
      evidence: FailedAttemptEvidence;
    };

/**
 * Releases a dispatched attempt whose OpenChannelSync failed, so its
 * settlements can be paid out by a new attempt. Only done when
 *   - lnd rejected the open itself and LND_REJECTED_RELEASE_DELAY_MS has
 *     passed, or the outcome is unknown and AMBIGUOUS_RELEASE_DELAY_MS has
 *     passed, and
 *   - lnd shows no channel with this attempt's memo and no new open, closing
 *     or closed channel to the peer since the attempt was reserved.
 * A failure to query lnd propagates: an attempt is never released blind.
 */
export async function releaseFailedChannelOpenAttempt(
  db: Database,
  lightning: Client,
  attempt: IChannelOpenAttemptDB,
  now = Date.now(),
  reasonPrefix = "Released after the channel open failed",
): Promise<ReleaseFailedAttemptResult> {
  const kind: ChannelOpenFailureKind = attempt.failureKind ?? "AMBIGUOUS";
  const delayMs =
    kind === "LND_REJECTED" ? LND_REJECTED_RELEASE_DELAY_MS : AMBIGUOUS_RELEASE_DELAY_MS;
  const releasableAt = attempt.updatedAt + delayMs;

  const { finalized, evidence } = await collectFailedAttemptEvidence(db, lightning, attempt);
  if (finalized) {
    return { status: "OPENED", attempt: finalized };
  }
  if (now < releasableAt) {
    return { status: "TOO_EARLY", attempt, releasableAt };
  }
  if (!evidence) {
    return { status: "NO_BASELINE", attempt };
  }
  if (!evidenceIsClean(evidence)) {
    return { status: "EVIDENCE_OF_CHANNEL", attempt, evidence };
  }

  const cancelled = await cancelChannelOpenAttempt(db, attempt.attemptId, {
    reason: `${reasonPrefix} (${kind}): ${attempt.error ?? "no error recorded"}`,
    allowDispatched: true,
    expectedUpdatedAt: attempt.updatedAt,
  });
  if (cancelled.status === "OPENED") {
    return { status: "OPENED", attempt: cancelled };
  }
  console.warn("Released failed channel-open attempt", {
    attemptId: attempt.attemptId,
    pubkey: attempt.pubkey,
    failureKind: kind,
  });
  return { status: "CANCELLED", attempt: cancelled };
}

/**
 * gRPC codes that mean the request may not have been answered by lnd itself.
 * Any other code is an error lnd returned, which it only does before the
 * channel becomes pending (nothing was funded).
 */
const AMBIGUOUS_GRPC_CODES = new Set([
  0, // OK (should not be an error at all)
  1, // CANCELLED
  4, // DEADLINE_EXCEEDED
  13, // INTERNAL
  14, // UNAVAILABLE
]);

export function classifyChannelOpenError(error: unknown): ChannelOpenFailureKind {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "number" || AMBIGUOUS_GRPC_CODES.has(code)) {
    return "AMBIGUOUS";
  }
  return "LND_REJECTED";
}

async function getFailedOpenBackoff(db: Database, pubkey: string, now: number) {
  const failures = await getRecentFailedChannelOpenAttempts(
    db,
    pubkey,
    now - FAILED_OPEN_BACKOFF_LOOKBACK_MS,
  );
  if (failures.length === 0) {
    return null;
  }
  const delayMs = Math.min(
    FAILED_OPEN_BACKOFF_BASE_MS * Math.pow(2, failures.length - 1),
    FAILED_OPEN_BACKOFF_MAX_MS,
  );
  const retryAt = failures[0].updatedAt + delayMs;
  return retryAt > now ? retryAt : null;
}

/**
 * Brings rows for HTLCs Dunder decided to settle (settled = 0) in line with
 * lnd, in case a SubscribeHtlcEvents event was missed (process restart, stream
 * reconnect). Needs lnd's `store-final-htlc-resolutions=true`; without it lnd
 * reports every HTLC as not found and the rows are left alone.
 */
let lookupHtlcResolutionUnavailableLogged = false;

export async function reconcileUnsettledHtlcSettlements(db: Database, lightning: Client) {
  const unsettled = await getUnsettledHtlcSettlements(db);
  const settledChannelIds = new Set<string>();
  for (const settlement of unsettled) {
    let resolution;
    try {
      resolution = await lookupHtlcResolution(
        lightning,
        Long.fromString(settlement.incomingChannelId, true),
        Long.fromString(settlement.htlcId, true),
      );
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 5) {
        // NOT_FOUND: not resolved yet (or resolutions aren't stored).
        continue;
      }
      if (!lookupHtlcResolutionUnavailableLogged) {
        lookupHtlcResolutionUnavailableLogged = true;
        console.warn(
          "Could not look up HTLC resolutions in lnd. Run lnd with " +
            "store-final-htlc-resolutions=true so missed settle events can be recovered.",
          error,
        );
      }
      return settledChannelIds;
    }

    if (resolution.settled) {
      if (
        await markHtlcSettlementSettled(db, settlement.incomingChannelId, settlement.htlcId)
      ) {
        settledChannelIds.add(settlement.channelId);
      }
    } else if (
      await deleteFailedHtlcSettlement(db, settlement.incomingChannelId, settlement.htlcId)
    ) {
      console.error("lnd failed an HTLC that Dunder had decided to settle; removed its record", {
        channelId: settlement.channelId,
        incomingChannelId: settlement.incomingChannelId,
        htlcId: settlement.htlcId,
      });
    }
  }
  return settledChannelIds;
}


type ChannelOpenMode = {
  zeroConf: boolean;
  taprootChannel: boolean;
};

function channelOpenErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function startChannelOpenHeartbeat(db: Database, attemptId: string) {
  const timer = setInterval(() => {
    void touchChannelOpenAttempt(db, attemptId).catch((error) => {
      console.error("Could not refresh channel-open attempt heartbeat", {
        attemptId,
        error,
      });
    });
  }, CHANNEL_OPEN_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

type ChannelOpenDispatchResult =
  | { status: "OPENED"; attempt: IChannelOpenAttemptDB }
  | { status: "ERROR"; attempt: IChannelOpenAttemptDB; error: unknown };

async function dispatchChannelOpen(
  options: OpenSettledHtlcsOptions,
  attempt: IChannelOpenAttemptDB,
  maximumPaymentSat: number,
  mode: ChannelOpenMode,
): Promise<ChannelOpenDispatchResult> {
  const dispatched = await markChannelOpenAttemptDispatched(
    options.db,
    attempt.attemptId,
    mode,
  );
  const stopHeartbeat = startChannelOpenHeartbeat(options.db, attempt.attemptId);
  try {
    const result = await openChannelSync(
      options.lightning,
      options.pubkey,
      Long.fromValue(getChannelCapacitySat(maximumPaymentSat)),
      Long.fromValue(dispatched.pushAmountSat),
      true,
      mode.zeroConf,
      mode.taprootChannel,
      getChannelOpenAttemptMemo(dispatched.attemptId),
    );
    let txId = result.fundingTxidStr ?? "";
    if (!txId && result.fundingTxidBytes && result.fundingTxidBytes.length > 0) {
      txId = bytesToHexString(Uint8Array.from(result.fundingTxidBytes).reverse());
    }
    if (!txId) {
      throw new Error("OpenChannelSync returned no funding transaction ID");
    }

    const channelPoint = `${txId}:${result.outputIndex}`;
    const finalized = await finalizeChannelOpenAttempt(
      options.db,
      dispatched.attemptId,
      channelPoint,
    );
    return { status: "OPENED", attempt: finalized };
  } catch (error) {
    return { status: "ERROR", attempt: dispatched, error };
  } finally {
    stopHeartbeat();
  }
}

export async function openChannelForSettledHtlcs(
  options: OpenSettledHtlcsOptions,
): Promise<OpenSettledHtlcsResult> {
  const activeAttempt = await getActiveChannelOpenAttempt(options.db, options.pubkey);
  if (activeAttempt) {
    const result = await reconcileChannelOpenAttempt(
      options.db,
      options.lightning,
      activeAttempt,
    );
    if (result.status !== "CANCELLED") {
      return result;
    }
    // rpcDispatched=0 proves that the stale attempt never crossed the
    // OpenChannelSync dispatch boundary. Its settlements have now been safely
    // released, so this invocation can continue and reserve them again.
  }

  // Reconciling an attempt that already reached lnd (above) only records its
  // outcome. Reserving and dispatching a new open is what the kill switch stops.
  if (!isChannelOpeningEnabled()) {
    return { status: "DISABLED" };
  }

  const retryAt = await getFailedOpenBackoff(options.db, options.pubkey, Date.now());
  if (retryAt !== null) {
    return { status: "BACKOFF", retryAt };
  }

  if (!(await checkPeerConnected(options.lightning, options.pubkey))) {
    return { status: "PEER_OFFLINE" };
  }

  const maximumPaymentSat = getMaximumPaymentSat();
  const [feeEstimate, peerChannelState, balance, closedPeerChannelPoints] = await Promise.all([
    estimateFee(options.lightning, Long.fromValue(maximumPaymentSat), 1),
    getPeerChannelState(options.lightning, options.pubkey),
    walletBalance(options.lightning),
    getPeerClosedChannelPoints(options.lightning, options.pubkey),
  ]);
  if (checkFeeTooHigh(feeEstimate.feerateSatPerByte, feeEstimate.feeSat)) {
    return { status: "FEES_TOO_HIGH" };
  }

  // Don't hand lnd an open it can't fund: that would only produce a failed,
  // dispatched attempt. lnd keeps part of the wallet for anchor fee bumping.
  const spendableSat = Long.fromValue(balance.confirmedBalance).subtract(
    Long.fromValue(balance.reservedBalanceAnchorChan ?? 0),
  );
  const neededSat = Long.fromValue(getChannelCapacitySat(maximumPaymentSat)).add(
    Long.fromValue(feeEstimate.feeSat),
  );
  if (spendableSat.lessThan(neededSat)) {
    console.error("Wallet balance too low to open a channel", {
      spendableSat: spendableSat.toString(),
      neededSat: neededSat.toString(),
    });
    return { status: "INSUFFICIENT_FUNDS" };
  }

  // Never start a second app-managed open while lnd already has an unrelated
  // pending open to this peer. An attempt owned by Dunder would have been found
  // and reconciled above.
  if (peerChannelState.pendingPeerChannelCount > 0) {
    return { status: "PENDING_CHANNEL" };
  }

  const reservation = await reserveChannelOpenAttempt(options.db, {
    attemptId: randomUUID(),
    pubkey: options.pubkey,
    source: options.source,
    requestedChannelId: options.requestedChannelId,
    requiredAmountSat: options.requiredAmountSat,
    maximumAmountSat: maximumPaymentSat,
    feeSat: getFeeChargeSat(feeEstimate.feeSat),
    existingChannelPoints: peerChannelState.channelPoints,
    existingClosedChannelPoints: closedPeerChannelPoints,
    zeroConf: options.zeroConf,
    taprootChannel: options.taprootChannel,
  });

  if (reservation.status === "ACTIVE_ATTEMPT") {
    return reconcileChannelOpenAttempt(options.db, options.lightning, reservation.attempt);
  }
  if (reservation.status !== "RESERVED") {
    return reservation;
  }

  const attempt = reservation.attempt;
  const mode: ChannelOpenMode = {
    zeroConf: options.zeroConf,
    taprootChannel: options.taprootChannel,
  };

  const dispatch = await dispatchChannelOpen(options, attempt, maximumPaymentSat, mode);
  if (dispatch.status === "OPENED") {
    return dispatch;
  }

  // A failed RPC can still leave an active funding workflow inside lnd. Check
  // for this attempt's exact memo, then retain the reservation if it is not yet
  // visible. Never downgrade the requested Taproot channel or dispatch a
  // second payout automatically.
  try {
    const reconciled = await tryReconcileChannelOpenAttempt(
      options.db,
      options.lightning,
      dispatch.attempt,
    );
    if (reconciled) {
      return { status: "OPENED", attempt: reconciled };
    }
  } catch (reconcileError) {
    console.error("Could not reconcile failed channel-open RPC", reconcileError);
  }

  const errorMessage = channelOpenErrorMessage(dispatch.error);
  const failureKind = classifyChannelOpenError(dispatch.error);
  await markChannelOpenAttemptUnknown(
    options.db,
    dispatch.attempt.attemptId,
    errorMessage,
    failureKind,
  );
  const unknownAttempt = await getChannelOpenAttempt(
    options.db,
    dispatch.attempt.attemptId,
  );
  if (!unknownAttempt) {
    throw new Error(`Lost channel-open attempt ${dispatch.attempt.attemptId}`);
  }
  if (unknownAttempt.status === "OPENED") {
    return { status: "OPENED", attempt: unknownAttempt };
  }
  console.error("Channel open failed; it is re-checked against lnd before any retry", {
    attemptId: attempt.attemptId,
    pubkey: attempt.pubkey,
    failureKind,
    error: errorMessage,
  });
  return { status: "UNKNOWN", attempt: unknownAttempt };
}

export type CancelStaleChannelOpenAttemptResult =
  | { status: "NOT_FOUND" }
  | { status: "NOT_ACTIVE"; attempt: IChannelOpenAttemptDB }
  | { status: "NOT_STALE"; attempt: IChannelOpenAttemptDB; staleAt: number }
  | { status: "OPENED"; attempt: IChannelOpenAttemptDB }
  | {
      status: "UNSAFE_TO_CANCEL";
      attempt: IChannelOpenAttemptDB;
      matchingMemoCount: number;
      newChannelPoints: string[];
      newClosingChannelPoints: string[];
      newClosedChannelPoints: string[];
      pendingPeerChannelCount: number;
      unidentifiedPeerChannelCount: number;
    }
  | { status: "CANCELLED"; attempt: IChannelOpenAttemptDB };

/**
 * Operator recovery for a stale attempt. A reservation that was never sent to
 * lnd can be released. A dispatched one is released only under the same rules
 * as automatic recovery (see releaseFailedChannelOpenAttempt): after lnd's
 * funding flow can no longer be running, and only if lnd shows no channel that
 * could belong to the attempt.
 */
export async function cancelStaleChannelOpenAttempt(options: {
  db: Database;
  lightning: Client;
  attemptId: string;
  expectedUpdatedAt: number;
  reason: string;
  now?: number;
}): Promise<CancelStaleChannelOpenAttemptResult> {
  const attempt = await getChannelOpenAttempt(options.db, options.attemptId);
  if (!attempt) {
    return { status: "NOT_FOUND" };
  }
  if (attempt.status !== "OPENING" && attempt.status !== "UNKNOWN") {
    return { status: "NOT_ACTIVE", attempt };
  }
  if (attempt.updatedAt !== options.expectedUpdatedAt) {
    throw new Error(`Channel-open attempt ${attempt.attemptId} changed before cancellation`);
  }

  const staleAt = attempt.updatedAt + CHANNEL_OPEN_ATTEMPT_STALE_MS;
  if ((options.now ?? Date.now()) < staleAt) {
    return { status: "NOT_STALE", attempt, staleAt };
  }

  if (attempt.rpcDispatched === 0) {
    const cancelled = await cancelChannelOpenAttempt(options.db, attempt.attemptId, {
      reason: `Operator released stale pre-dispatch reservation: ${options.reason}`,
      allowDispatched: false,
      expectedUpdatedAt: attempt.updatedAt,
    });
    return cancelled.status === "OPENED"
      ? { status: "OPENED", attempt: cancelled }
      : { status: "CANCELLED", attempt: cancelled };
  }

  // A failure to query lnd is intentionally propagated. An operator must never
  // release an ambiguous payout merely because reconciliation was unavailable.
  const release = await releaseFailedChannelOpenAttempt(
    options.db,
    options.lightning,
    attempt,
    options.now ?? Date.now(),
    `Operator released dispatched attempt: ${options.reason}`,
  );
  if (release.status === "OPENED" || release.status === "CANCELLED") {
    return { status: release.status, attempt: release.attempt };
  }
  if (release.status === "TOO_EARLY") {
    return { status: "NOT_STALE", attempt, staleAt: release.releasableAt };
  }
  if (release.status === "EVIDENCE_OF_CHANNEL") {
    return {
      status: "UNSAFE_TO_CANCEL",
      attempt,
      matchingMemoCount: release.evidence.matchingMemoCount,
      newChannelPoints: release.evidence.newChannelPoints,
      newClosingChannelPoints: release.evidence.newClosingChannelPoints,
      newClosedChannelPoints: release.evidence.newClosedChannelPoints,
      pendingPeerChannelCount: release.evidence.pendingPeerChannelCount,
      unidentifiedPeerChannelCount: release.evidence.unidentifiedPeerChannelCount,
    };
  }

  // NO_BASELINE: the attempt predates the closed-channel baseline. Check what
  // lnd shows now; for closed channels rely on the operator's confirmation
  // (the admin API requires `confirmNoClosedChannel`).
  const inspection = await inspectChannelOpenAttempt(options.db, options.lightning, attempt);
  if (inspection.finalized) {
    return { status: "OPENED", attempt: inspection.finalized };
  }
  const baseline = parseChannelPointList(attempt.existingChannelPoints);
  const newChannelPoints = baseline
    ? inspection.state.channelPoints.filter((point) => !baseline.has(point))
    : inspection.state.channelPoints;
  const newClosingChannelPoints = baseline
    ? inspection.state.closingChannelPoints.filter((point) => !baseline.has(point))
    : inspection.state.closingChannelPoints;
  const unidentifiedPeerChannelCount = inspection.state.observedChannels.filter(
    (channel) => !channel.channelPoint,
  ).length;
  if (
    baseline &&
    inspection.matchingMemoCount === 0 &&
    newChannelPoints.length === 0 &&
    newClosingChannelPoints.length === 0 &&
    unidentifiedPeerChannelCount === 0
  ) {
    const cancelled = await cancelChannelOpenAttempt(options.db, attempt.attemptId, {
      reason: `Operator released dispatched attempt without closed-channel baseline: ${options.reason}`,
      allowDispatched: true,
      expectedUpdatedAt: attempt.updatedAt,
    });
    return cancelled.status === "OPENED"
      ? { status: "OPENED", attempt: cancelled }
      : { status: "CANCELLED", attempt: cancelled };
  }

  return {
    status: "UNSAFE_TO_CANCEL",
    attempt,
    matchingMemoCount: inspection.matchingMemoCount,
    newChannelPoints,
    newClosingChannelPoints,
    newClosedChannelPoints: [],
    pendingPeerChannelCount: inspection.state.pendingPeerChannelCount,
    unidentifiedPeerChannelCount,
  };
}

/**
 * Reconcile unresolved attempts first, then drain fully-settled automatic
 * requests in creation order. Only one attempt per peer can be unresolved, so
 * a blocked peer is skipped while unrelated peers continue to make progress.
 */
export async function recoverChannelOpenState(db: Database, lightning: Client) {
  const blockedPubkeys = new Set<string>();
  const results: OpenSettledHtlcsResult[] = [];

  try {
    await reconcileUnsettledHtlcSettlements(db, lightning);
  } catch (error) {
    console.error("Could not reconcile unsettled HTLC records with lnd", error);
  }

  const activeAttempts = await getActiveChannelOpenAttempts(db);
  for (const attempt of activeAttempts) {
    const result = await reconcileChannelOpenAttempt(db, lightning, attempt);
    results.push(result);
    if (result.status === "IN_PROGRESS" || result.status === "UNKNOWN") {
      blockedPubkeys.add(attempt.pubkey);
    }
  }

  // Recording outcomes and releasing failed attempts (above) continues while
  // channel opening is disabled; starting new opens doesn't.
  if (!isChannelOpeningEnabled()) {
    return results;
  }

  const allowZeroConfChannels = config.get<boolean>("allowZeroConfChannels") || false;
  const allowTaprootChannels = config.get<boolean>("allowTaprootChannels") || false;
  const requests = await getRecoverableAutomaticChannelRequests(db);

  for (const request of requests) {
    if (blockedPubkeys.has(request.pubkey)) {
      continue;
    }

    const result = await openChannelForSettledHtlcs({
      db,
      lightning,
      pubkey: request.pubkey,
      source: "AUTOMATIC",
      requestedChannelId: request.channelId,
      requiredAmountSat: request.expectedAmountSat,
      zeroConf: allowZeroConfChannels,
      taprootChannel: allowTaprootChannels,
    });
    results.push(result);

    // OPENED and NO_SETTLEMENTS are terminal for this request. Any other
    // result should defer later requests for this peer until the next pass.
    if (result.status !== "OPENED" && result.status !== "NO_SETTLEMENTS") {
      blockedPubkeys.add(request.pubkey);
    }
  }

  return results;
}

/**
 * Run recovery once at startup and periodically afterwards. The timer is only
 * a trigger: the queue and ownership information live in SQLite.
 */
export function startChannelOpenRecovery(
  db: Database,
  lightning: Client,
  intervalMs = 10_000,
) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (delayMs: number) => {
    if (stopped) {
      return;
    }
    timer = setTimeout(run, delayMs);
    timer.unref();
  };

  const run = async () => {
    try {
      await recoverChannelOpenState(db, lightning);
    } catch (error) {
      console.error("Could not recover channel-open state", error);
    } finally {
      schedule(intervalMs);
    }
  };

  schedule(0);

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}
