import { FastifyPluginAsync, FastifyRequest } from "fastify";
import { Client } from "@grpc/grpc-js";
import secp256k1 from "secp256k1";
import config from "config";

import getDb from "../../../db/db";
import {
  checkAdminPubkey,
  createAdmin,
  deleteAdmins,
  getAdmins,
  updateAdmins,
} from "../../../db/admin";
import {
  bytesToHexString,
  createLnUrlAuth,
  generateBytes,
  hexToUint8Array,
  LnUrlAuthQuerystring,
} from "../../../utils/common";
import { IErrorResponse } from "../../../services/ondemand-channel";
import { SocketStream } from "@fastify/websocket";
import { requireAuthenticatedAdmin } from "./auth";

interface ICreateAdminLnUrlAuthRequests {
  k1: string;
  actorPubkey: string;
  callback: (pubkey: string) => void;
}

let createAdminLnUrlAuthRequests: ICreateAdminLnUrlAuthRequests[] = [];

const AdminAdmin = async function (app, { lightning, router }) {
  const db = await getDb();

  app.post<{
    Body: {
      pubkey: string;
      name: string;
    };
  }>("/admins", async (request, reply) => {
    if (!(await requireAuthenticatedAdmin(db, request, reply))) {
      return;
    }

    await createAdmin(db, request.body.pubkey, request.body.name);
    return {
      pubkey: request.body.pubkey,
      id: request.body.pubkey,
    };
  });

  app.get<{
    Querystring: {
      filter: string;
      range: string;
      sort: string;
    };
  }>("/admins", async (request, reply) => {
    if (!(await requireAuthenticatedAdmin(db, request, reply))) {
      return;
    }

    let filter;
    if (request.query.filter) {
      filter = JSON.parse(request.query.filter);

      // id means pubkey
      if (filter.id) {
        filter.pubkey = filter.id;
        delete filter.id;
      }
    }

    let range: [number, number] | undefined;
    if (request.query.range) {
      range = JSON.parse(request.query.range);
    }

    let sort: [string, string] | undefined;
    if (request.query.sort) {
      sort = JSON.parse(request.query.sort) as [string, string];

      // id means pubkey
      if (sort[0] === "id") {
        sort[0] = "pubkey";
      }
    }

    const admins = (await getAdmins(db, undefined, filter, range, sort)).map((admins) => {
      return {
        ...admins,
        id: admins.pubkey,
      };
    });
    return admins;
  });

  app.get<{
    Params: {
      pubkey: string;
    };
  }>("/admins/:pubkey", async (request, reply) => {
    if (!(await requireAuthenticatedAdmin(db, request, reply))) {
      return;
    }

    const admins = (await getAdmins(db, request.params.pubkey)).map((admins) => {
      return {
        ...admins,
        id: admins.pubkey,
      };
    });
    return admins[0];
  });

  app.delete<{
    Querystring: {
      filter: string;
    };
  }>("/admins", async (request, reply) => {
    const actorPubkey = await requireAuthenticatedAdmin(db, request, reply);
    if (!actorPubkey) {
      console.warn("Rejected unauthenticated administrator deletion", {
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return;
    }

    if (!request.query.filter) {
      reply.code(400);
      return {
        status: "ERROR",
        message: "Missing filter",
      };
    }

    let filter: unknown;
    try {
      filter = JSON.parse(request.query.filter);
    } catch {
      reply.code(400);
      return {
        status: "ERROR",
        message: "Invalid filter",
      };
    }

    if (!filter || typeof filter !== "object") {
      reply.code(400);
      return {
        status: "ERROR",
        message: "Invalid filter",
      };
    }

    const rawPubkeys = (filter as any).pubkey ?? (filter as any).id;
    const pubkeys = [...new Set(Array.isArray(rawPubkeys) ? rawPubkeys : [rawPubkeys])];
    if (
      pubkeys.length === 0 ||
      pubkeys.length > 100 ||
      pubkeys.some((pubkey) => typeof pubkey !== "string" || pubkey.length === 0)
    ) {
      reply.code(400);
      return {
        status: "ERROR",
        message: "Invalid administrator pubkey filter",
      };
    }

    if (pubkeys.includes(actorPubkey)) {
      reply.code(400);
      return {
        status: "ERROR",
        message: "You cannot delete yourself.",
      };
    }

    await deleteAdmins(db, pubkeys as string[]);
    console.warn("Administrators deleted", {
      actorPubkey,
      targetPubkeys: pubkeys,
      remoteAddress: request.ip,
    });
    return pubkeys;
  });

  app.put<{
    Params: {
      pubkey: string;
    };
    Body: {
      name: string;
    };
  }>("/admins/:pubkey", async (request, reply) => {
    if (!(await requireAuthenticatedAdmin(db, request, reply))) {
      return;
    }

    await updateAdmins(db, {
      pubkey: request.params.pubkey,
      name: request.body.name,
    });

    const admin = (await getAdmins(db, request.params.pubkey)).map((admin) => {
      return {
        ...admin,
        id: admin.pubkey,
      };
    });
    return admin[0];
  });

  // Custom
  app.get(
    "/create-admin-lnurl-auth-ws",
    { websocket: true },
    async (connection: SocketStream, request: FastifyRequest) => {
      const session = request.session as any;
      const sessionPubkey = session.get("pubkey");
      if (
        session.get("authenticated") !== true ||
        typeof sessionPubkey !== "string" ||
        !(await checkAdminPubkey(db, sessionPubkey))
      ) {
        console.log("No session");
        connection.socket.close();
        return;
      }

      const serverDomain = config.get<string>("serverDomain");

      const k1 = bytesToHexString(await generateBytes(32));
      const bech32Data = createLnUrlAuth(k1, `${serverDomain}/admin/api/lnurl-auth`);

      const promise = new Promise<string>((resolve) => {
        // Add request to our array of current requests
        createAdminLnUrlAuthRequests.push({
          k1,
          actorPubkey: sessionPubkey,
          callback: resolve,
        });

        // Delete it after a while:
        setTimeout(() => {
          createAdminLnUrlAuthRequests = createAdminLnUrlAuthRequests.filter(
            (req) => req.k1 !== k1,
          );
        }, 5 * 60 * 1000);
      });

      promise.then((pubkey) => {
        connection.socket.send(
          JSON.stringify({
            pubkey,
          }),
        );
      });

      connection.socket.send(
        JSON.stringify({
          lnurlAuth: bech32Data,
        }),
      );
    },
  );

  app.get<{
    Querystring: LnUrlAuthQuerystring;
  }>("/lnurl-auth", async (request, reply) => {
    // Look for the request
    const req = createAdminLnUrlAuthRequests.find((r) => {
      return r.k1 === request.query.k1;
    });
    if (!req) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: "Couldn't find the corresponding session.",
      };
      return error;
    }

    if (!(await checkAdminPubkey(db, req.actorPubkey))) {
      createAdminLnUrlAuthRequests = createAdminLnUrlAuthRequests.filter(
        (pendingRequest) => pendingRequest.k1 !== request.query.k1,
      );
      reply.code(403);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: "The administrator session that created this request is no longer authorized.",
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
          "The Public key provided doesn't match with the public key extracted from the signature. ",
      };
      return error;
    }

    createAdminLnUrlAuthRequests = createAdminLnUrlAuthRequests.filter(
      (req) => req.k1 !== request.query.k1,
    );

    req.callback(request.query.key);

    return reply.send({ status: "OK" });
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default AdminAdmin;
