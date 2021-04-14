import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";

import getDb from "../../../db/db";
import { getHtlcSettlements, getHtlcSettlementsTotal } from "../../../db/ondemand-channel-admin";

const AdminHtlcSettlements = async function (app, { lightning, router }) {
  const db = await getDb();

  app.get<{
    Querystring: {
      filter: string;
      range: string;
      sort: string;
    };
  }>("/htlcSettlements", async (request, reply) => {
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

    const htlcSettlements = (await getHtlcSettlements(db, undefined, filter, range, sort)).map(
      (htlcSettlement) => {
        return {
          ...htlcSettlement,
          id: `${htlcSettlement.channelId}-${htlcSettlement.incomingChannelId}-${htlcSettlement.htlcId}`,
          claimed: !!htlcSettlement.claimed,
          settled: !!htlcSettlement.settled,
        };
      },
    );
    reply.header("x-total-items", await getHtlcSettlementsTotal(db));
    return htlcSettlements;
  });

  // TODO htlcId/Id looks weird
  app.get<{
    Params: {
      htlcId: string;
    };
  }>("/htlcSettlements/:htlcId", async (request, reply) => {
    if (request.session.authenticated !== true) {
      reply.code(403);
      reply.send("Not authenticated");
      return;
    }

    const htlcId = Number.parseInt(request.params.htlcId, 10);

    const htlcSettlements = (await getHtlcSettlements(db, htlcId)).map((htlcSettlement) => {
      return {
        ...htlcSettlement,
        id: `${htlcSettlement.channelId}-${htlcSettlement.incomingChannelId}-${htlcSettlement.htlcId}`,
        claimed: !!htlcSettlement.claimed,
        settled: !!htlcSettlement.settled,
      };
    });
    return htlcSettlements[0];
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default AdminHtlcSettlements;
