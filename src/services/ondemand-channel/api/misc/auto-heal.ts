import { Client } from "@grpc/grpc-js";
import config from "config";
import { Database } from "sqlite";

import { getChannelRequestUnclaimedAmount } from "../../../../db/ondemand-channel";
import { lnrpc } from "../../../../proto";
import { subscribePeerEvents } from "../../../../utils/lnd-api";
import { subscribeWithReconnect } from "../../../../utils/reconnecting-stream";
import { openChannelForSettledHtlcs } from "../../channel-open";
import { isChannelOpeningEnabled } from "../utils";

export async function openAutoHealChannelIfNeeded(
  db: Database,
  lightning: Client,
  pubkey: string,
) {
  if (!isChannelOpeningEnabled()) {
    return;
  }

  // Peer-online events are remote-triggerable. Avoid the more expensive lnd
  // peer, fee, channel and pending-channel RPCs when there is nothing to pay.
  if ((await getChannelRequestUnclaimedAmount(db, pubkey)) === 0) {
    return;
  }

  const allowZeroConfChannels = config.get<boolean>("allowZeroConfChannels") || false;
  const allowTaprootChannels = config.get<boolean>("allowTaprootChannels") || false;
  return openChannelForSettledHtlcs({
    db,
    lightning,
    pubkey,
    source: "AUTO_HEAL",
    zeroConf: allowZeroConfChannels,
    taprootChannel: allowTaprootChannels,
  });
}

/**
 * AutoHeal automatically opens a channel to a peer that has settled but
 * non-claimed HTLCs.
 * TODO test the peer-event integration
 */
export default function AutoHeal(db: Database, lightning: Client, _router: Client) {
  return subscribeWithReconnect(
    () => subscribePeerEvents(lightning),
    async (data) => {
      const peerEvent = lnrpc.PeerEvent.decode(data);

      if (peerEvent.type === lnrpc.PeerEvent.EventType.PEER_OFFLINE) {
        return;
      }

      try {
        const result = await openAutoHealChannelIfNeeded(db, lightning, peerEvent.pubKey);
        if (
          result &&
          result.status !== "OPENED" &&
          result.status !== "NO_SETTLEMENTS"
        ) {
          console.warn("Autoheal: channel open did not complete", {
            pubkey: peerEvent.pubKey,
            status: result.status,
          });
        }
      } catch (error) {
        console.error("Autoheal: Could not open channel", error);
      }
    },
    { name: "SubscribePeerEvents" },
  );
}
