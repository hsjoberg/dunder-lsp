import { FastifyReply, FastifyRequest } from "fastify";
import { Database } from "sqlite";

import { checkAdminPubkey } from "../../../db/admin";

/**
 * Session authentication alone is not enough: an administrator that has been
 * removed from the database must lose access immediately, even if an old
 * in-memory session still exists.
 */
export async function requireAuthenticatedAdmin(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const session = request.session as any;
  const pubkey = session.get("pubkey");
  if (
    session.get("authenticated") !== true ||
    typeof pubkey !== "string" ||
    !(await checkAdminPubkey(db, pubkey))
  ) {
    reply.code(403);
    reply.send("Not authenticated");
    return null;
  }

  return pubkey;
}
