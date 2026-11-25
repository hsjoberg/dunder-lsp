import { Client } from "@grpc/grpc-js";
import { Database } from "sqlite";
import config from "config";

import { getUnsettledHtlcSettlements } from "../../db/ondemand-channel";
import { lnrpc } from "../../proto";
import {
  bumpForceCloseFee,
  forceCloseChannel,
  getInfo,
  listChannels,
  pendingChannels,
} from "../../utils/lnd-api";

/*
 * Deadline guard
 * --------------
 * When Dunder settles a part, the payer gets the preimage at once, but the
 * part is only Dunder's once the payer has also locked the settlement in. A
 * payer (or the routing node right before Dunder) that stops responding at
 * that point keeps the HTLC in its commitment and can take it back on-chain
 * after it expires. lnd normally prevents that by going on-chain in time with
 * the preimage, but it doesn't know preimages supplied through the
 * interceptor, so it never does.
 *
 * Dunder does it instead: shortly before such an HTLC expires, it force-closes
 * the incoming channel. lnd then offers the HTLC to the interceptor again,
 * Dunder answers SETTLE ("already recorded"), and lnd claims it on-chain with
 * the preimage. The payout follows lnd's final outcome, after the claim's
 * timelock.
 *
 * Dunder only accepts an HTLC with at least 18 more blocks left than this
 * (MIN_BLOCKS_UNTIL_EXPIRY in register.ts), so an honest payer always has time
 * to lock the settlement in (it takes seconds) before the guard acts, and lnd
 * still has this many blocks to confirm the close and claim the HTLC.
 *
 * A part below the channel's dust limit has no output on-chain, so closing
 * for it gains nothing; it is skipped (and would otherwise let a peer make
 * Dunder pay for a force close with a few sats).
 */
export const FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY = 18;
const CHECK_INTERVAL_MS = 60_000;

/**
 * A claimed part gets its final outcome once the claim's timelock (at most
 * 2016 blocks) has passed. A part still unsettled four weeks after its
 * expiry never will by itself, and its request is never paid out.
 */
export const OVERDUE_BLOCKS_AFTER_EXPIRY = 4032;
const reportedOverdue = new Set<string>();

/**
 * Force-closes every channel that holds a part Dunder settled but lnd hasn't
 * finally settled, when that part expires within the deadline. Returns the
 * channel points it closed.
 */
export async function forceCloseChannelsWithStalledSettlements(db: Database, lightning: Client) {
  const unsettled = (await getUnsettledHtlcSettlements(db)).filter(
    (settlement) => settlement.incomingExpiry != null,
  );
  if (unsettled.length === 0) {
    return [];
  }
  const height = (await getInfo(lightning)).blockHeight;
  for (const settlement of unsettled) {
    const key = `${settlement.incomingChannelId}:${settlement.htlcId}`;
    if (
      height - settlement.incomingExpiry! > OVERDUE_BLOCKS_AFTER_EXPIRY &&
      !reportedOverdue.has(key)
    ) {
      reportedOverdue.add(key);
      console.error(
        "A settled part still has no final outcome long after its expiry; its request won't be paid out without a look",
        {
          channelId: settlement.channelId,
          incomingChannelId: settlement.incomingChannelId,
          htlcId: settlement.htlcId,
          amountMsat: settlement.amountMsat,
          incomingExpiry: settlement.incomingExpiry,
          height,
        },
      );
    }
  }
  const due = unsettled.filter(
    (settlement) => settlement.incomingExpiry! - height <= FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY,
  );
  if (due.length === 0) {
    return [];
  }

  const closed: string[] = [];
  const { channels } = await listChannels(lightning);
  for (const channel of channels as lnrpc.Channel[]) {
    const ids = new Set(
      [channel.chanId, channel.zeroConfConfirmedScid, ...(channel.aliasScids ?? [])]
        .filter((id) => id && id.toString() !== "0")
        .map((id) => id.toString()),
    );
    // Only parts whose HTLC is still pending on the channel. A part that was
    // locked in (and only its final event was missed) is no longer there.
    // Dust HTLCs have no output on Dunder's commitment, so nothing to claim.
    // Only the dust limit counts, not the HTLC transaction's fee that older
    // channels also trim by: the channel opener sets that fee rate, so a payer
    // that opened the channel could raise it to make the guard skip its part.
    const dustLimitSat = Number(channel.localConstraints?.dustLimitSat ?? 0);
    const stalled = due.filter(
      (settlement) =>
        ids.has(settlement.incomingChannelId) &&
        channel.pendingHtlcs.some(
          (htlc) =>
            htlc.incoming &&
            htlc.htlcIndex?.toString() === settlement.htlcId &&
            Number(htlc.amount ?? 0) >= dustLimitSat,
        ),
    );
    if (stalled.length === 0) {
      continue;
    }

    console.error(
      "Force-closing a channel: its peer hasn't locked in a part Dunder settled, and the HTLC expires soon",
      {
        channelPoint: channel.channelPoint,
        remotePubkey: channel.remotePubkey,
        height,
        parts: stalled.map((settlement) => ({
          channelId: settlement.channelId,
          htlcId: settlement.htlcId,
          amountMsat: settlement.amountMsat,
          incomingExpiry: settlement.incomingExpiry,
        })),
      },
    );
    try {
      await forceCloseChannel(lightning, channel.channelPoint);
      closed.push(channel.channelPoint);
    } catch (error) {
      console.error("Could not force-close the channel", {
        channelPoint: channel.channelPoint,
        error,
      });
    }
  }
  return closed;
}

/*
 * Fee bumping
 * -----------
 * A force close confirms only at the fee rate its commitment already has; on
 * a channel the peer opened, the peer chose that rate. lnd doesn't treat the
 * close as urgent either: it doesn't know preimages given through the
 * interceptor, so it sees no HTLCs at stake. And it offers the HTLC for the
 * on-chain claim only 3 to 6 confirmations after the close. A close that
 * confirms too late lets the payer take the HTLC back after its expiry while
 * holding the preimage. That holds both for the guard's own close and for a
 * close the payer broadcasts itself.
 *
 * So every closing channel that still holds a part Dunder settled gets its
 * close bumped through its anchor, to confirm early enough for the claim.
 * lnd's fee function starts at the market rate and rises towards the budget
 * only as the deadline nears; the budget is a hard ceiling. It is at most
 * half the parts' value, so making Dunder spend it puts at least twice that
 * at stake (lost to the payer if the bump works), and at most
 * `forceCloseFeeBumpMaxSat`.
 */
export const FEE_BUMP_BUDGET_RATIO = 0.5;
export const DEFAULT_FEE_BUMP_MAX_SAT = 50_000;
/** lnd waits up to 6 confirmations before the claim, which needs one more block. */
export const BLOCKS_NEEDED_AFTER_CLOSE = 8;

const ANCHOR_COMMITMENT_TYPES = new Set<lnrpc.CommitmentType>([
  lnrpc.CommitmentType.ANCHORS,
  lnrpc.CommitmentType.SCRIPT_ENFORCED_LEASE,
  lnrpc.CommitmentType.SIMPLE_TAPROOT,
  lnrpc.CommitmentType.SIMPLE_TAPROOT_OVERLAY,
]);

function getFeeBumpMaxSat() {
  return config.has("forceCloseFeeBumpMaxSat")
    ? config.get<number>("forceCloseFeeBumpMaxSat")
    : DEFAULT_FEE_BUMP_MAX_SAT;
}

/** Budget last registered per channel point, so lnd is asked again only on a change. */
const bumped = new Map<string, number>();

/**
 * lnd keeps sweep settings in memory only: after a restart it registers the
 * anchors again with its own budget (about 330 sat, no deadline). The
 * interceptor stream resetting is how an lnd restart shows here, so the bumps
 * are sent again on the next run. Not on every run: each request makes lnd
 * restart the sweep's fee function.
 */
export function forgetFeeBumps() {
  bumped.clear();
}

/**
 * Bumps the unconfirmed close of every channel that holds a part Dunder
 * settled but lnd hasn't finally settled. Returns the channel points bumped
 * in this call.
 */
export async function bumpClosesWithStalledSettlements(db: Database, lightning: Client) {
  const unsettled = (await getUnsettledHtlcSettlements(db)).filter(
    (settlement) => settlement.incomingExpiry != null && settlement.incomingChannelPoint,
  );
  if (unsettled.length === 0) {
    return [];
  }
  const { waitingCloseChannels } = await pendingChannels(lightning);
  if (waitingCloseChannels.length === 0) {
    return [];
  }
  const height = (await getInfo(lightning)).blockHeight;
  // Forget channels whose close has confirmed.
  const closing = new Set(waitingCloseChannels.map(({ channel }) => channel?.channelPoint));
  for (const channelPoint of bumped.keys()) {
    if (!closing.has(channelPoint)) {
      bumped.delete(channelPoint);
    }
  }

  const done: string[] = [];
  for (const { channel } of waitingCloseChannels) {
    const channelPoint = channel?.channelPoint;
    const commitmentType = channel?.commitmentType ?? lnrpc.CommitmentType.UNKNOWN_COMMITMENT_TYPE;
    if (!channelPoint || !ANCHOR_COMMITMENT_TYPES.has(commitmentType)) {
      continue;
    }
    const parts = unsettled.filter(
      (settlement) =>
        settlement.incomingChannelPoint === channelPoint && settlement.incomingExpiry! > height,
    );
    if (parts.length === 0) {
      continue;
    }
    const valueSat = parts.reduce((sum, part) => sum + part.amountSat, 0);
    const budgetSat = Math.min(Math.floor(valueSat * FEE_BUMP_BUDGET_RATIO), getFeeBumpMaxSat());
    if (budgetSat <= 0 || bumped.get(channelPoint) === budgetSat) {
      continue;
    }
    const firstExpiry = Math.min(...parts.map((part) => part.incomingExpiry!));
    const deadlineDelta = Math.max(1, firstExpiry - height - BLOCKS_NEEDED_AFTER_CLOSE);
    try {
      await bumpForceCloseFee(lightning, channelPoint, deadlineDelta, budgetSat);
      bumped.set(channelPoint, budgetSat);
      done.push(channelPoint);
      console.log("Bumped the fee of a close that holds settled parts", {
        channelPoint,
        deadlineDelta,
        budgetSat,
        parts: parts.length,
      });
    } catch (error) {
      // Tried again on the next run, e.g. while lnd hasn't registered the
      // anchor yet right after the close.
      console.error("Could not bump the fee of a close that holds settled parts", {
        channelPoint,
        error,
      });
    }
  }
  return done;
}

export function startSettlementDeadlineGuard(db: Database, lightning: Client) {
  let running = false;
  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await forceCloseChannelsWithStalledSettlements(db, lightning);
    } catch (error) {
      console.error("Settlement deadline check failed", error);
    }
    try {
      await bumpClosesWithStalledSettlements(db, lightning);
    } catch (error) {
      console.error("Could not check closing channels for fee bumps", error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
