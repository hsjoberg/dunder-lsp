import { randomUUID } from "crypto";
import { Client } from "@grpc/grpc-js";
import config from "config";
import { Database } from "sqlite";
import Long from "long";

import {
  ChannelOpenAttemptSource,
  IChannelOpenAttemptDB,
  finalizeChannelOpenAttempt,
  getActiveChannelOpenAttempt,
  getActiveChannelOpenAttempts,
  getChannelOpenAttempt,
  getRecoverableAutomaticChannelRequests,
  markChannelOpenAttemptUnknown,
  reserveChannelOpenAttempt,
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
  | { status: "NO_SETTLEMENTS" }
  | { status: "AMOUNT_MISMATCH"; amountSat: number }
  | { status: "FEE_EXCEEDS_AMOUNT"; amountSat: number }
  | { status: "FEES_TOO_HIGH" }
  | { status: "PEER_OFFLINE" }
  | { status: "PENDING_CHANNEL" };

type PeerChannelState = {
  channelPoints: string[];
  pendingChannelPoints: string[];
  observedChannels: { channelPoint: string; memo: string }[];
};

const CHANNEL_OPEN_MEMO_PREFIX = "dunder-payout:";

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
  const pendingChannelPoints = pending.pendingOpenChannels
    .filter((pendingChannel) => pendingChannel.channel?.remoteNodePub === pubkey)
    .map((pendingChannel) => pendingChannel.channel?.channelPoint)
    .filter((channelPoint): channelPoint is string => !!channelPoint);
  const observedChannels: PeerChannelState["observedChannels"] = [];
  for (const channel of channels.channels) {
    if (channel.remotePubkey === pubkey && channel.channelPoint) {
      observedChannels.push({
        channelPoint: channel.channelPoint,
        memo: channel.memo ?? "",
      });
    }
  }
  for (const pendingChannel of pending.pendingOpenChannels) {
    const channel = pendingChannel.channel;
    if (channel?.remoteNodePub === pubkey && channel.channelPoint) {
      observedChannels.push({
        channelPoint: channel.channelPoint,
        memo: channel.memo ?? "",
      });
    }
  }

  return {
    channelPoints: [...new Set([...activeChannelPoints, ...pendingChannelPoints])].sort(),
    pendingChannelPoints: [...new Set(pendingChannelPoints)].sort(),
    observedChannels,
  };
}

async function tryReconcileChannelOpenAttempt(
  db: Database,
  lightning: Client,
  attempt: IChannelOpenAttemptDB,
) {
  const state = await getPeerChannelState(lightning, attempt.pubkey);
  const expectedMemo = getChannelOpenAttemptMemo(attempt.attemptId);
  const matchingChannelPoints = [
    ...new Set(
      state.observedChannels
        .filter((channel) => channel.memo === expectedMemo)
        .map((channel) => channel.channelPoint),
    ),
  ];

  // Do not infer ownership merely from a new channel to the same peer. Other
  // operators or processes can open one concurrently. The lnd memo binds the
  // observed channel to this exact durable payout attempt.
  if (matchingChannelPoints.length !== 1) {
    return null;
  }

  return finalizeChannelOpenAttempt(db, attempt.attemptId, matchingChannelPoints[0]);
}

export async function reconcileChannelOpenAttempt(
  db: Database,
  lightning: Client,
  attempt: IChannelOpenAttemptDB,
): Promise<OpenSettledHtlcsResult> {
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

export async function openChannelForSettledHtlcs(
  options: OpenSettledHtlcsOptions,
): Promise<OpenSettledHtlcsResult> {
  const activeAttempt = await getActiveChannelOpenAttempt(options.db, options.pubkey);
  if (activeAttempt) {
    return reconcileChannelOpenAttempt(options.db, options.lightning, activeAttempt);
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
  if (peerChannelState.pendingChannelPoints.length > 0) {
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
  try {
    const result = await openChannelSync(
      options.lightning,
      options.pubkey,
      Long.fromValue(maximumPaymentSat).add(10_000),
      Long.fromValue(attempt.pushAmountSat),
      true,
      options.spendUnconfirmed,
      options.zeroConf,
      options.taprootChannel,
      getChannelOpenAttemptMemo(attempt.attemptId),
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
      attempt.attemptId,
      channelPoint,
    );
    return { status: "OPENED", attempt: finalized };
  } catch (error) {
    // The RPC may have committed the funding transaction before the transport
    // reported an error. Reconcile once, then preserve an UNKNOWN reservation
    // instead of issuing a potentially duplicate push.
    try {
      const reconciled = await tryReconcileChannelOpenAttempt(
        options.db,
        options.lightning,
        attempt,
      );
      if (reconciled) {
        return { status: "OPENED", attempt: reconciled };
      }
    } catch (reconcileError) {
      console.error("Could not reconcile failed channel-open RPC", reconcileError);
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    await markChannelOpenAttemptUnknown(options.db, attempt.attemptId, errorMessage);
    const unknownAttempt = await getChannelOpenAttempt(options.db, attempt.attemptId);
    if (!unknownAttempt) {
      throw new Error(`Lost channel-open attempt ${attempt.attemptId}`);
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
