import { Client } from "@grpc/grpc-js";
import Long from "long";
import { Database } from "sqlite";

import {
  getChannelRequestUnclaimedAmount,
  updateChannelRequestSetAllRegisteredAsDone,
  updateHtlcSettlementSetAllAsClaimed,
} from "../../../../db/ondemand-channel";
import { pendingChannels, subscribePeerEvents, openChannelSync } from "../../../../utils/lnd-api";
import { getMaximumPaymentSat } from "../utils";
import { bytesToHexString } from "../../../../utils/common";
import { lnrpc } from "../../../../proto";

/**
 * AutoHeal automatically opens a channel to a peer that has settled but non-claimed HTLCs
 * TODO test
 */
export default function AutoHeal(db: Database, lightning: Client, router: Client) {
  const maximumPaymentSat = getMaximumPaymentSat();
  const stream = subscribePeerEvents(lightning);

  stream.on("data", async (data) => {
    const peerEvent = lnrpc.PeerEvent.decode(data);

    if (peerEvent.type === lnrpc.PeerEvent.EventType.PEER_OFFLINE) {
      return;
    }

    const unclaimed = await getChannelRequestUnclaimedAmount(db, peerEvent.pubKey);
    if (unclaimed === 0) {
      return;
    }

    // Check if there are currently any pending channels for the user.
    // If so, don't do anything.
    const pendingChans = await pendingChannels(lightning);
    if (
      pendingChans.pendingOpenChannels.find(
        (pendingChan) => pendingChan.channel?.remoteNodePub === peerEvent.pubKey,
      )
    ) {
      return;
    }

    try {
      const localFunding = Long.fromValue(maximumPaymentSat).add(10_000);
      const pushAmount = Long.fromValue(unclaimed);
      const result = await openChannelSync(
        lightning,
        peerEvent.pubKey,
        localFunding,
        pushAmount,
        true,
        true,
      );
      const txId = bytesToHexString(result.fundingTxidBytes.reverse());
      await updateChannelRequestSetAllRegisteredAsDone(
        db,
        peerEvent.pubKey,
        `${txId}:${result.outputIndex}`,
      );
      await updateHtlcSettlementSetAllAsClaimed(db, peerEvent.pubKey);
    } catch (error) {
      console.error("Autoheal: Could not open channel", error);
    }
  });
}
