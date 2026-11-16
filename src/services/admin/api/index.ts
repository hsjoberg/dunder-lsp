import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";

import getDb from "../../../db/db";
import Login from "./login";
import AdminChannelRequests from "./channel-requests";
import AdminHtlcSettlements from "./htlc-settlements";
import AdminAdmin from "./admin";
import AdminPendingChannels from "./pending-channels";
import AdminChannelOpenAttempts from "./channel-open-attempts";

export interface IErrorResponse {
  status: "ERROR";
  reason: string;
}

const AdminApi = async function (app, { lightning, router }) {
  const db = await getDb();

  app.register(Login);
  app.register(AdminAdmin);
  app.register(AdminChannelRequests);
  app.register(AdminHtlcSettlements);
  app.register(AdminPendingChannels, { lightning, router });
  app.register(AdminChannelOpenAttempts, { lightning });

  app.get("/logout", async (request) => {
    // Destroy through the session itself: destroying only the stored copy
    // leaves request.session in place, and @fastify/session saves it back
    // when the response is sent, so the cookie would stay logged in.
    await request.session.destroy();
    return "OK";
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default AdminApi;
