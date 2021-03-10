import { FastifyPluginAsync, FastifyRequest } from "fastify";
import { Client } from "@grpc/grpc-js";
import fastifySession from "fastify-session";
import secp256k1 from "secp256k1";
import { SocketStream } from "fastify-websocket";
import config from "config";

import {
  bytesToHexString,
  createLnUrlAuth,
  generateBytes,
  hexToUint8Array,
  LnUrlAuthQuerystring,
} from "../../../../utils/common";
import getDb from "../../../../db/db";
import { checkAdminPubkey } from "../../../../db/admin";

export interface IErrorResponse {
  status: "ERROR";
  reason: string;
}

interface IUser {
  sessionId: string;
  connection: SocketStream;
  sessionStore: fastifySession.SessionStore;
  session: FastifyRequest["session"];
  k1: string;
}
const users: Map<SocketStream, IUser> = new Map();

const AdminLogin = async function (app, { lightning, router }) {
  const db = await getDb();

  app.get("/test", async () => {
    return "1";
  });

  app.get(
    "/login-ws",
    { websocket: true },
    async (connection: SocketStream, request: FastifyRequest) => {
      const serverDomain = config.get<string>("serverDomain");

      const sessionId = request.session.sessionId;
      const k1 = bytesToHexString(await generateBytes(32));

      users.set(connection, {
        sessionId: sessionId,
        connection,
        sessionStore: request.sessionStore,
        session: request.session,
        k1,
      });

      connection.socket.on("message", (message: any) => {
        if (message === "GET_LNURL") {
          const bech32Data = createLnUrlAuth(k1, `${serverDomain}/admin/api/login`);

          connection.socket.send(
            JSON.stringify({
              lnurlAuth: bech32Data,
            }),
          );
        } else {
          connection.socket.send(
            JSON.stringify({
              status: "ERROR",
              reason: "Unknown request",
            }),
          );
        }
      });

      connection.socket.on("close", () => {
        users.delete(connection);
        console.log(users);
      });
    },
  );

  app.get<{
    Querystring: LnUrlAuthQuerystring;
  }>("/login", async (request, reply: any) => {
    if (typeof request.query !== "object") {
      return;
    }

    if (typeof request.query.sig !== "string") {
    }

    const u = [...users].filter(([_, user]) => {
      return user.k1 === request.query.k1;
    });
    if (u.length === 0) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: "Couldn't find the corresponding session.",
      };
      return error;
    }

    // Verify that the message is valid
    const signature = secp256k1.signatureImport(hexToUint8Array(request.query.sig));
    const valid = secp256k1.ecdsaVerify(
      signature,
      hexToUint8Array(request.query.k1),
      hexToUint8Array(request.query.key),
    );
    if (!valid) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason:
          "The Public key provided doesn't match with the public key extracted from the signature. " +
          "Either the signature is wrong or you have signed with the wrong wallet.",
      };
      return error;
    }

    if (!(await checkAdminPubkey(db, request.query.key))) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: `The public key "${request.query.key}" is not a valid administrator.`,
      };
      return error;
    }

    u[0][1].sessionStore.set(
      u[0][1].sessionId,
      {
        authenticated: true,
        pubkey: request.query.key,
      },
      (err) => console.error(err),
    );

    await Promise.all(
      u.map(([_, user]) => {
        user.connection.socket.send(
          JSON.stringify({
            status: "OK",
          }),
        );
      }),
    );

    return reply.send({ status: "OK" });
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default AdminLogin;
