import config from "config";
import { FastifyInstance } from "fastify";

const DEFAULT_REQUESTS_PER_MINUTE = 120;
const WINDOW_MS = 60_000;
const MAX_TRACKED_ADDRESSES = 100_000;

/**
 * Public, unauthenticated routes, including the admin login (login,
 * login-ws, login-complete). The rest of the admin interface requires a login.
 */
const LIMITED_PREFIXES = ["/ondemand-channel/", "/getInfo", "/estimateFee", "/admin/api/login"];

/**
 * The address a limit applies to. An IPv6 client usually controls a whole /64
 * and could otherwise use a new address for every request, so IPv6 addresses
 * are limited per /64.
 */
export function clientKey(ip: string) {
  const address = ip.split("%")[0]; // Drop an IPv6 zone ("%eth0").
  if (!address.includes(":")) {
    return address;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) {
    return mapped[1]; // IPv4-mapped IPv6: the IPv4 address.
  }
  if (address.includes(".")) {
    return address; // Other embedded-IPv4 forms are rare; keep the full address.
  }
  const [head, tail] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? headParts
      : [...headParts, ...Array(8 - headParts.length - tailParts.length).fill("0"), ...tailParts];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group || "0", 16).toString(16))
    .join(":")}::/64`;
}

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
    // Decide by the matched route, not the raw URL: the router decodes the
    // path before matching, so "/%67etInfo" reaches /getInfo without starting
    // with "/getInfo".
    const route = request.routeOptions.url;
    if (limit <= 0 || !route || !LIMITED_PREFIXES.some((prefix) => route.startsWith(prefix))) {
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

    const address = clientKey(request.ip);
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
