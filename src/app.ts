import fastify, { FastifyServerOptions } from "fastify";
import fastifyCors from "@fastify/cors";
import Long from "long";

import { getInfo, estimateFee } from "./utils/lnd-api";
import { getGrpcClients } from "./utils/grpc";
import { assertEnvironment } from "./utils/common";
import { registerIpRateLimit } from "./services/ip-rate-limit";
import config from "config";

const { lightning, router } = getGrpcClients();
const PUBLIC_CACHE_MS = 30_000;

assertEnvironment();

/**
 * Admin when either the matched route or the URL (as sent or decoded) is under
 * /admin. A percent-encoded admin path still matches its admin route, and a
 * CORS preflight (OPTIONS) matches @fastify/cors's catch-all route instead.
 */
export function isAdminPath(routeUrl: string | undefined, rawUrl: string) {
  let decoded = rawUrl;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    // Malformed encoding; the raw URL is checked anyway.
  }
  return [routeUrl ?? "", rawUrl, decoded].some((url) => url.startsWith("/admin"));
}

export default function (options?: FastifyServerOptions) {
  const app = fastify({
    // Behind a reverse proxy, which proxies to trust for X-Forwarded-For
    // (e.g. "127.0.0.1" or a hop count). Needed for per-IP rate limiting.
    trustProxy: config.has("trustProxy") ? config.get<any>("trustProxy") : false,
    ...options,
  });
  registerIpRateLimit(app);
  // The public wallet API may be called from browsers. The admin interface is
  // same-origin only and never gets CORS headers.
  app.register(fastifyCors, {
    delegator: (request, callback) => {
      callback(null, { origin: !isAdminPath(request.routeOptions.url, request.url) });
    },
  });

  app.get("/", async () => "hello, world");

  app.register(require("./services/ondemand-channel/index"), {
    prefix: "/ondemand-channel",
    lightning,
    router,
  });

  app.register(require("./services/public-forward-firewall/index"), {
    lightning,
    router,
  });

  app.register(require("./services/admin/index"), {
    prefix: "/admin",
    lightning,
    router,
  });

  // Public and unauthenticated, so answer from a short cache instead of
  // calling lnd for every request.
  const feeEstimateCache = new Map<number, { expiresAt: number; value: Promise<unknown> }>();
  app.get<{
    Querystring: { targetConf?: string };
  }>("/estimateFee", async function (request, reply) {
    const targetConf = Number(request.query.targetConf ?? 1);
    if (!Number.isSafeInteger(targetConf) || targetConf < 1 || targetConf > 1008) {
      reply.code(400);
      return { status: "ERROR", reason: "targetConf must be an integer between 1 and 1008" };
    }
    const now = Date.now();
    const cached = feeEstimateCache.get(targetConf);
    if (cached && cached.expiresAt > now) {
      return await cached.value;
    }
    const value = estimateFee(lightning, Long.fromValue(100000), targetConf);
    feeEstimateCache.set(targetConf, { expiresAt: now + PUBLIC_CACHE_MS, value });
    value.catch(() => feeEstimateCache.delete(targetConf));
    return await value;
  });

  // Only what a client needs to find and connect to the node; the full lnd
  // GetInfo (versions, chain sync state, features, ...) isn't public.
  let infoCache: { expiresAt: number; value: Promise<unknown> } | null = null;
  app.get("/getInfo", async function () {
    const now = Date.now();
    if (!infoCache || infoCache.expiresAt <= now) {
      const value = getInfo(lightning).then((info) => ({
        identityPubkey: info.identityPubkey,
        alias: info.alias,
        uris: info.uris,
      }));
      infoCache = { expiresAt: now + PUBLIC_CACHE_MS, value };
      value.catch(() => {
        infoCache = null;
      });
    }
    return await infoCache.value;
  });

  return app;
}
