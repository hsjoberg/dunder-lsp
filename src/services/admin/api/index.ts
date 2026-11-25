import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";

import getDb from "../../../db/db";
import Login from "./login";
import AdminChannelRequests from "./channel-requests";
import AdminHtlcSettlements from "./htlc-settlements";
import AdminAdmin from "./admin";
import AdminPendingChannels from "./pending-channels";
import AdminChannelOpenAttempts from "./channel-open-attempts";
import { isSameOrigin } from "./same-origin";

export interface IErrorResponse {
  status: "ERROR";
  reason: string;
}

const AdminApi = async function (app, { lightning, router }) {
  const db = await getDb();

  app.register(Login, { lightning, router });
  app.register(AdminAdmin, { lightning, router });
  app.register(AdminChannelRequests, { lightning, router });
  app.register(AdminHtlcSettlements, { lightning, router });
  app.register(AdminPendingChannels, { lightning, router });
  app.register(AdminChannelOpenAttempts, { lightning });

  // POST with an Origin check, so a page elsewhere (another subdomain gets
  // the SameSite cookie too) can't log the admin out.
  app.post("/logout", async (request, reply) => {
    if (!isSameOrigin(request)) {
      reply.code(403);
      return "Origin not allowed";
    }
    // Destroy through the session itself: destroying only the stored copy
    // leaves request.session in place, and @fastify/session saves it back
    // when the response is sent, so the cookie would stay logged in.
    await request.session.destroy();
    return "OK";
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default AdminApi;
