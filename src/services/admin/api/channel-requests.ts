import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";

import getDb from "../../../db/db";
import { getChannelRequests, getChannelRequestTotal } from "../../../db/ondemand-channel-admin";

const AdminChannelRequests = async function (app, { lightning, router }) {
  const db = await getDb();

  app.get<{
    Querystring: {
      filter: string;
      range: string;
      sort: string;
    };
  }>("/channelRequests", async (request, reply) => {
    if (request.session.authenticated !== true) {
      reply.code(403);
      reply.send("Not authenticated");
      return;
    }

    let filter;
    if (request.query.filter) {
      filter = JSON.parse(request.query.filter);

      // id means channelId
      if (filter.id) {
        filter.channelId = filter.id;
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

      // id means channelId
      if (sort[0] === "id") {
        sort[0] = "channelId";
      }
    }

    const channelRequests = (await getChannelRequests(db, undefined, filter, range, sort)).map(
      (channelRequest) => {
        return {
          ...channelRequest,
          id: channelRequest.channelId,
          expired: !!(channelRequest as any).expired,
        };
      },
    );
    reply.header("x-total-items", await getChannelRequestTotal(db));
    return channelRequests;
  });

  app.get<{
    Params: {
      channelId: string;
    };
  }>("/channelRequests/:channelId", async (request, reply) => {
    if (request.session.authenticated !== true) {
      reply.code(403);
      reply.send("Not authenticated");
      return;
    }

    const channelRequests = (await getChannelRequests(db, request.params.channelId)).map(
      (channelRequest) => {
        return {
          ...channelRequest,
          id: channelRequest.channelId,
        };
      },
    );
    return channelRequests[0];
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default AdminChannelRequests;
