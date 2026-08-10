import { Client } from "@grpc/grpc-js";
import { Database } from "sqlite";

import { lnrpc } from "../../../../proto";
import { subscribePeerEvents } from "../../../../utils/lnd-api";
import { openChannelForSettledHtlcs } from "../../channel-open";

/**
 * AutoHeal automatically opens a channel to a peer that has settled but
 * non-claimed HTLCs.
 * TODO test the peer-event integration
 */
export default function AutoHeal(db: Database, lightning: Client, _router: Client) {
  const stream = subscribePeerEvents(lightning);

  stream.on("data", async (data) => {
    const peerEvent = lnrpc.PeerEvent.decode(data);

    if (peerEvent.type === lnrpc.PeerEvent.EventType.PEER_OFFLINE) {
      return;
    }

    try {
      const result = await openChannelForSettledHtlcs({
        db,
        lightning,
        pubkey: peerEvent.pubKey,
        source: "AUTO_HEAL",
        spendUnconfirmed: false,
        zeroConf: false,
        taprootChannel: false,
      });
      if (result.status !== "OPENED" && result.status !== "NO_SETTLEMENTS") {
        console.warn("Autoheal: channel open did not complete", {
          pubkey: peerEvent.pubKey,
          status: result.status,
        });
      }
    } catch (error) {
      console.error("Autoheal: Could not open channel", error);
    }
  });
}
