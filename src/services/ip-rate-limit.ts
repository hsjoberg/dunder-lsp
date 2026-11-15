import config from "config";
import { FastifyInstance } from "fastify";

const DEFAULT_REQUESTS_PER_MINUTE = 120;
const WINDOW_MS = 60_000;
const MAX_TRACKED_ADDRESSES = 100_000;

/** Public, unauthenticated routes. The admin interface has its own login. */
const LIMITED_PREFIXES = ["/ondemand-channel/", "/getInfo", "/estimateFee"];

function getLimitPerMinute() {
  return config.has("ipRateLimitPerMinute")
    ? config.get<number>("ipRateLimitPerMinute")
    : DEFAULT_REQUESTS_PER_MINUTE;
}

/**
 * Limits requests per client IP to the public API. Runs before the body is
 * parsed or lnd is called (VerifyMessage, ListPeers, EstimateFee, ...).
 *
 * Behind a reverse proxy every request comes from the proxy's address, so all
 * clients would share one limit. Set `trustProxy` (see README) so `request.ip`
 * is the client's address from X-Forwarded-For.
 */
export function registerIpRateLimit(app: FastifyInstance) {
  const windows = new Map<string, { start: number; count: number }>();

  app.addHook("onRequest", async (request, reply) => {
    const limit = getLimitPerMinute();
    if (limit <= 0 || !LIMITED_PREFIXES.some((prefix) => request.url.startsWith(prefix))) {
      return;
    }

    const now = Date.now();
    if (windows.size >= MAX_TRACKED_ADDRESSES) {
      for (const [address, window] of windows) {
        if (now - window.start >= WINDOW_MS) {
          windows.delete(address);
        }
      }
      if (windows.size >= MAX_TRACKED_ADDRESSES) {
        // Still full of active addresses: start over rather than grow.
        windows.clear();
      }
    }

    const address = request.ip;
    const window = windows.get(address);
    if (!window || now - window.start >= WINDOW_MS) {
      windows.set(address, { start: now, count: 1 });
      return;
    }
    window.count += 1;
    if (window.count > limit) {
      reply.header("Retry-After", Math.ceil((window.start + WINDOW_MS - now) / 1000));
      reply.code(429);
      return reply.send({ status: "ERROR", reason: "Too many requests. Try again in a minute." });
    }
  });
}
