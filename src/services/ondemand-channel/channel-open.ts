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
  getRecoverableAutomaticChannelRequests,
  markChannelOpenAttemptDispatched,
  markChannelOpenAttemptUnknown,
  reserveChannelOpenAttempt,
  touchChannelOpenAttempt,
} from "../../db/channel-open-attempt";
import {
  checkPeerConnected,
  estimateFee,
  listChannels,
  openChannelSync,
  pendingChannels,
} from "../../utils/lnd-api";
import { bytesToHexString } from "../../utils/common";
import {
  checkFeeTooHigh,
  getFeeChargeSat,
  getMaximumPaymentSat,
} from "./api/utils";

type OpenSettledHtlcsOptions = {
  db: Database;
  lightning: Client;
  pubkey: string;
  source: ChannelOpenAttemptSource;
  requestedChannelId?: string;
  requiredAmountSat?: number;
  spendUnconfirmed: boolean;
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
  | { status: "PENDING_CHANNEL" };

type PeerChannelState = {
  channelPoints: string[];
  pendingPeerChannelCount: number;
  observedChannels: { channelPoint: string | null; memo: string }[];
};

const CHANNEL_OPEN_MEMO_PREFIX = "dunder-payout:";
const CHANNEL_OPEN_HEARTBEAT_MS = 10_000;
export const CHANNEL_OPEN_ATTEMPT_STALE_MS = 5 * 60 * 1000;

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

  return {
    channelPoints: [...new Set([...activeChannelPoints, ...pendingChannelPoints])].sort(),
    pendingPeerChannelCount: peerPendingChannels.length,
    observedChannels,
  };
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

  return attempt.status === "UNKNOWN"
    ? { status: "UNKNOWN", attempt }
    : { status: "IN_PROGRESS", attempt };
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
      Long.fromValue(maximumPaymentSat).add(10_000),
      Long.fromValue(dispatched.pushAmountSat),
      true,
      options.spendUnconfirmed,
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

  if (!(await checkPeerConnected(options.lightning, options.pubkey))) {
    return { status: "PEER_OFFLINE" };
  }

  const maximumPaymentSat = getMaximumPaymentSat();
  const [feeEstimate, peerChannelState] = await Promise.all([
    estimateFee(options.lightning, Long.fromValue(maximumPaymentSat), 1),
    getPeerChannelState(options.lightning, options.pubkey),
  ]);
  if (checkFeeTooHigh(feeEstimate.feerateSatPerByte, feeEstimate.feeSat)) {
    return { status: "FEES_TOO_HIGH" };
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
    spendUnconfirmed: options.spendUnconfirmed,
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
  await markChannelOpenAttemptUnknown(
    options.db,
    dispatch.attempt.attemptId,
    errorMessage,
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
  console.error("Channel-open result is unknown; refusing to retry automatically", {
    attemptId: attempt.attemptId,
    pubkey: attempt.pubkey,
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
      pendingPeerChannelCount: number;
      unidentifiedPeerChannelCount: number;
    }
  | { status: "CANCELLED"; attempt: IChannelOpenAttemptDB };

/**
 * Operator recovery for a stale attempt. A reservation that was never sent to
 * lnd can be released. Once dispatch may have happened, this function can only
 * reconcile the exact memo: a point-in-time empty lnd snapshot cannot prove
 * that an in-memory funding workflow will not complete later.
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
  const inspection = await inspectChannelOpenAttempt(
    options.db,
    options.lightning,
    attempt,
  );
  if (inspection.finalized) {
    return { status: "OPENED", attempt: inspection.finalized };
  }

  let newChannelPoints = inspection.state.channelPoints;
  try {
    const parsed = JSON.parse(attempt.existingChannelPoints);
    if (!Array.isArray(parsed) || !parsed.every((point) => typeof point === "string")) {
      throw new Error("Invalid existing channel-point baseline");
    }
    const existing = new Set<string>(parsed);
    newChannelPoints = inspection.state.channelPoints.filter((point) => !existing.has(point));
  } catch {
    // Keep every observed point in the diagnostics when the baseline is
    // malformed. Dispatched attempts remain reserved either way.
  }

  const unidentifiedPeerChannelCount = inspection.state.observedChannels.filter(
    (channel) => !channel.channelPoint,
  ).length;
  return {
    status: "UNSAFE_TO_CANCEL",
    attempt,
    matchingMemoCount: inspection.matchingMemoCount,
    newChannelPoints,
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

  const activeAttempts = await getActiveChannelOpenAttempts(db);
  for (const attempt of activeAttempts) {
    const result = await reconcileChannelOpenAttempt(db, lightning, attempt);
    results.push(result);
    if (result.status === "IN_PROGRESS" || result.status === "UNKNOWN") {
      blockedPubkeys.add(attempt.pubkey);
    }
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
      spendUnconfirmed: false,
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
