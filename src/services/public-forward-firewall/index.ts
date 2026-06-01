import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";
import config from "config";

import {
  handled,
  HtlcHandler,
  noDecision,
  startHtlcInterceptor,
} from "../htlc-interceptor";
import { lnrpc, routerrpc } from "../../proto";
import { listChannels } from "../../utils/lnd-api";

const configEnabled = (key: string) => config.has(key) && config.get<boolean>(key);

type ChannelVisibilityCache = {
  expiresAt: number;
  publicByChannelId: Map<string, boolean>;
};

export function createPublicPublicForwardBlocker(lightning: Client): HtlcHandler {
  const cacheTtlMs = 30_000;
  let cache: ChannelVisibilityCache = {
    expiresAt: 0,
    publicByChannelId: new Map(),
  };

  const getVisibility = async () => {
    const now = Date.now();
    if (now < cache.expiresAt) {
      return cache.publicByChannelId;
    }

    const response = await listChannels(lightning);
    const publicByChannelId = new Map<string, boolean>();
    for (const channel of response.channels) {
      if (channel.chanId) {
        publicByChannelId.set(channel.chanId.toString(), !channel.private);
      }
    }

    cache = {
      expiresAt: now + cacheTtlMs,
      publicByChannelId,
    };
    return cache.publicByChannelId;
  };

  return async (request, writer) => {
    const incomingChannelId = request.incomingCircuitKey?.chanId?.toString();
    const outgoingChannelId = request.outgoingRequestedChanId?.toString();

    if (!incomingChannelId || !outgoingChannelId || outgoingChannelId === "0") {
      console.log("Resuming HTLC because channel ids are missing", {
        incomingChannelId,
        outgoingChannelId,
      });
      writer.respond(routerrpc.ResolveHoldForwardAction.RESUME, request.incomingCircuitKey);
      return handled();
    }

    let visibility: Map<string, boolean>;
    try {
      visibility = await getVisibility();
    } catch (error) {
      console.error("Could not list channels for public-public HTLC check, resuming", error);
      writer.respond(routerrpc.ResolveHoldForwardAction.RESUME, request.incomingCircuitKey);
      return handled();
    }

    const incomingPublic = visibility.get(incomingChannelId);
    const outgoingPublic = visibility.get(outgoingChannelId);
    if (incomingPublic === undefined || outgoingPublic === undefined) {
      console.log("Skipping public-public HTLC check because channel visibility was not found", {
        incomingChannelId,
        outgoingChannelId,
      });
      return noDecision();
    }

    if (incomingPublic && outgoingPublic) {
      console.log("Rejecting public-public HTLC forward", {
        incomingChannelId,
        outgoingChannelId,
      });
      writer.respond(
        routerrpc.ResolveHoldForwardAction.FAIL,
        request.incomingCircuitKey,
        undefined,
        lnrpc.Failure.FailureCode.TEMPORARY_CHANNEL_FAILURE,
      );
      return handled();
    }

    writer.respond(routerrpc.ResolveHoldForwardAction.RESUME, request.incomingCircuitKey);
    return handled();
  };
}

const PublicForwardFirewall = async function (app, { lightning, router }) {
  if (!configEnabled("rejectPublicPublicHtlcForwards")) {
    return;
  }

  const unregister = startHtlcInterceptor(router).registerHandler(
    createPublicPublicForwardBlocker(lightning),
  );

  app.addHook("onClose", async () => {
    unregister();
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

export default PublicForwardFirewall;
