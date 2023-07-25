import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";

import Long from "long";
import { listChannels, getInfo } from "../../utils/lnd-api";
import { hexToUint8Array } from "../../utils/common";
import { routerrpc } from "../../proto";

const GetFoaFInfo = async function (app, { lightning, router }) {
  app.get("/", async (request, reply) => {
    const nodeInfo = await getInfo(lightning);

    const channels = await listChannels(lightning, true);

    const ximport = {
      pairs: channels.channels.map((channel) => {
        return {
          nodeFrom: nodeInfo.identityPubkey,
          nodeTo: channel.remotePubkey,
          history: {
            successAmtSat:
              channel.localBalance?.toNumber()! - channel.localChanReserveSat?.toNumber()!,
            successTime: +new Date(),
          },
        };
      }),
    };
    return ximport;
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default GetFoaFInfo;
