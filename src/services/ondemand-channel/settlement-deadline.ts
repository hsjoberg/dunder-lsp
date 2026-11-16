import { Client } from "@grpc/grpc-js";
import { Database } from "sqlite";

import { getUnsettledHtlcSettlements } from "../../db/ondemand-channel";
import { lnrpc } from "../../proto";
import { forceCloseChannel, getInfo, listChannels } from "../../utils/lnd-api";

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
 * Dunder only accepts an HTLC with more than 19 blocks left before its expiry,
 * so an honest payer always has time to lock the settlement in (it takes
 * seconds) before the guard acts, and lnd still has this many blocks to
 * confirm the close and claim the HTLC.
 */
export const FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY = 18;
const CHECK_INTERVAL_MS = 60_000;

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
    const stalled = due.filter(
      (settlement) =>
        ids.has(settlement.incomingChannelId) &&
        channel.pendingHtlcs.some(
          (htlc) => htlc.incoming && htlc.htlcIndex?.toString() === settlement.htlcId,
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
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
