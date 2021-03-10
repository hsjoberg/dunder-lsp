import { FastifyPluginAsync, FastifyRequest } from "fastify";
import { Client } from "@grpc/grpc-js";
import secp256k1 from "secp256k1";
import config from "config";

import getDb from "../../../db/db";
import { createAdmin, deleteAdmins, getAdmins, updateAdmins } from "../../../db/admin";
import {
  bytesToHexString,
  createLnUrlAuth,
  generateBytes,
  hexToUint8Array,
  LnUrlAuthQuerystring,
} from "../../../utils/common";
import { IErrorResponse } from "../../../services/ondemand-channel";
import { SocketStream } from "fastify-websocket";

interface ICreateAdminLnUrlAuthRequests {
  k1: string;
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
    if (request.session.authenticated !== true) {
      reply.code(403);
      reply.send("Not authenticated");
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
    if (request.session.authenticated !== true) {
      reply.code(403);
      reply.send("Not authenticated");
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
    if (request.session.authenticated !== true) {
      reply.code(403);
      reply.send("Not authenticated");
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
    if (request.query.filter) {
      const filter = JSON.parse(request.query.filter);

      // id means pubkey
      if (filter.id) {
        filter.pubkey = filter.id;
        delete filter.id;
      }

      if (!filter.pubkey) {
        reply.code(400);
        return {
          status: "ERROR",
          message: "Missing filter",
        };
      }

      if (filter.pubkey.includes(request.session.pubkey)) {
        reply.code(400);
        return {
          status: "ERROR",
          message: "You cannot delete yourself.",
        };
      }

      await deleteAdmins(db, filter);
      return filter.pubkey;
    } else {
      reply.code(400);
      return {
        status: "ERROR",
        message: "Missing filter",
      };
    }
  });

  app.put<{
    Params: {
      pubkey: string;
    };
    Body: {
      name: string;
    };
  }>("/admins/:pubkey", async (request, reply) => {
    if (request.session.authenticated !== true) {
      reply.code(403);
      reply.send("Not authenticated");
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
      if (request.session.authenticated !== true) {
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
