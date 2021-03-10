import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";

import getDb from "../../../db/db";
import Login from "./login";
import AdminChannelRequests from "./channel-requests";
import AdminHtlcSettlements from "./htlc-settlements";
import AdminAdmin from "./admin";

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

  app.get("/logout", async (request) => {
    request.sessionStore.destroy(request.session.sessionId, (error) => console.error(error));
    return "OK";
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default AdminApi;
