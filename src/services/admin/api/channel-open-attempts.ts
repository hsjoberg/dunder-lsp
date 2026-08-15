import { Client } from "@grpc/grpc-js";
import { FastifyPluginAsync } from "fastify";

import {
  getChannelOpenAttempt,
  getChannelOpenAttempts,
} from "../../../db/channel-open-attempt";
import getDb from "../../../db/db";
import { cancelStaleChannelOpenAttempt } from "../../ondemand-channel/channel-open";
import { requireAuthenticatedAdmin } from "./auth";

const AdminChannelOpenAttempts = async function (app, { lightning }) {
  const db = await getDb();

  app.get("/channel-open-attempts", async (request, reply) => {
    if (!(await requireAuthenticatedAdmin(db, request, reply))) {
      return;
    }

    return (await getChannelOpenAttempts(db)).map((attempt) => ({
      ...attempt,
      id: attempt.attemptId,
    }));
  });

  app.post<{
    Params: { attemptId: string };
    Body: {
      confirmation: string;
      expectedUpdatedAt: number;
      confirmNoClosedChannel: boolean;
      reason: string;
    };
  }>("/channel-open-attempts/:attemptId/cancel", async (request, reply) => {
    const actorPubkey = await requireAuthenticatedAdmin(db, request, reply);
    if (!actorPubkey) {
      return;
    }

    const { attemptId } = request.params;
    const body = request.body;
    if (
      !body ||
      body.confirmation !== attemptId ||
      body.confirmNoClosedChannel !== true ||
      !Number.isSafeInteger(body.expectedUpdatedAt) ||
      typeof body.reason !== "string" ||
      body.reason.trim().length < 10
    ) {
      reply.code(400);
      return {
        status: "ERROR",
        reason:
          "Confirm the exact attempt ID, its updatedAt value, that no payout channel already " +
          "opened and closed, and provide a reason of at least 10 characters.",
      };
    }

    try {
      const result = await cancelStaleChannelOpenAttempt({
        db,
        lightning,
        attemptId,
        expectedUpdatedAt: body.expectedUpdatedAt,
        reason: body.reason.trim(),
      });

      if (result.status === "NOT_FOUND") {
        reply.code(404);
        return { status: "ERROR", reason: "Channel-open attempt not found" };
      }
      if (
        result.status === "NOT_ACTIVE" ||
        result.status === "NOT_STALE" ||
        result.status === "UNSAFE_TO_CANCEL"
      ) {
        reply.code(409);
        return result;
      }

      console.warn("Administrator resolved stale channel-open attempt", {
        actorPubkey,
        attemptId,
        result: result.status,
        reason: body.reason.trim(),
        remoteAddress: request.ip,
      });
      return result;
    } catch (error) {
      // This includes failed lnd reconciliation and a heartbeat/version race.
      // Both must fail closed, leaving the payout reservation intact.
      reply.code(503);
      return {
        status: "ERROR",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // A focused single-attempt endpoint makes it easy for an operator to obtain
  // the exact updatedAt value required by the guarded cancellation request.
  app.get<{ Params: { attemptId: string } }>(
    "/channel-open-attempts/:attemptId",
    async (request, reply) => {
      if (!(await requireAuthenticatedAdmin(db, request, reply))) {
        return;
      }

      const attempt = await getChannelOpenAttempt(db, request.params.attemptId);
      if (!attempt) {
        reply.code(404);
        return { status: "ERROR", reason: "Channel-open attempt not found" };
      }
      return { ...attempt, id: attempt.attemptId };
    },
  );
} as FastifyPluginAsync<{ lightning: Client }>;

export default AdminChannelOpenAttempts;
