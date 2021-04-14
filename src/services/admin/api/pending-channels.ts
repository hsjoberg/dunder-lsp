import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";

import getDb from "../../../db/db";
import { getHtlcSettlements, getHtlcSettlementsTotal } from "../../../db/ondemand-channel-admin";
import { pendingChannels } from "../../../utils/lnd-api";
import { lnrpc } from "proto";

interface PendingChannel extends lnrpc.PendingChannelsResponse.IPendingChannel {
  id: string;
}

const AdminPendingChannels = async function (app, { lightning, router }) {
  const db = await getDb();

  app.get<{
    Querystring: {
      filter: string;
      range: string;
      sort: string;
    };
  }>("/pendingChannels", async (request, reply) => {
    if (request.session.authenticated !== true) {
      reply.code(403);
      reply.send("Not authenticated");
      return;
    }

    let filter;
    if (request.query.filter) {
      filter = JSON.parse(request.query.filter);

      // id means htlcId
      if (filter.id) {
        filter.hltId = filter.id;
        delete filter.id;
      }
    }

    let range: [number, number];
    if (request.query.range) {
      range = JSON.parse(request.query.range);
    } else {
      range = [0, 1000];
    }

    let sort: [string, string] | undefined;
    if (request.query.sort) {
      sort = JSON.parse(request.query.sort) as [string, string];

      // id means htlcId
      if (sort[0] === "id") {
        sort[0] = "htlcId";
      }
    }

    const pendingChans = (await pendingChannels(lightning)).pendingOpenChannels.map(
      (pendingChannel) => {
        return {
          id: pendingChannel.channel?.channelPoint,
          channelPoint: pendingChannel.channel?.channelPoint,
          remoteNodePub: pendingChannel.channel?.remoteNodePub,
          localBalance: pendingChannel.channel?.localBalance?.toNumber(),
          remoteBalance: pendingChannel.channel?.remoteBalance?.toNumber(),
          capacity: pendingChannel.channel?.capacity?.toString(),
          commitFee: pendingChannel.commitFee?.toString(),
        };
      },
    );

    reply.header("x-total-items", pendingChans.length);
    return pendingChans;
  });

  app.get<{
    Params: {
      channelPoint: string;
    };
  }>("/pendingChannels/:channelPoint", async (request, reply) => {
    if (request.session.authenticated !== true) {
      reply.code(403);
      reply.send("Not authenticated");
      return;
    }

    const channelPoint = request.params.channelPoint;

    const pendingChans = [
      (await pendingChannels(lightning)).pendingOpenChannels.find((pendingChannel) => {
        return pendingChannel.channel?.channelPoint === channelPoint;
      }),
    ]?.map((pendingChannel) => {
      return {
        id: pendingChannel?.channel?.channelPoint,
        ...pendingChannel?.channel,
      };
    });

    return pendingChans[0];
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default AdminPendingChannels;
