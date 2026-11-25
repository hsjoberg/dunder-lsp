import { FastifyRequest } from "fastify";

/**
 * Browsers send Origin with every WebSocket handshake and every POST; it must
 * be this server. The session cookie is SameSite, which still lets pages on
 * other subdomains of the same site send it, so this check is what keeps them
 * out. A request without Origin doesn't come from a browser page.
 */
export function isSameOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}
