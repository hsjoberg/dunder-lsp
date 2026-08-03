import build from "../../../src/app";
import getDb from "../../../src/db/db";
import { createAdmin, deleteAdmins, getAdmins } from "../../../src/db/admin";
import { requireAuthenticatedAdmin } from "../../../src/services/admin/api/auth";

const ADMIN_PUBKEY = `02${"11".repeat(32)}`;

describe("administrator authorization", () => {
  test("rejects an unauthenticated wildcard delete without changing administrators", async () => {
    const db = await getDb(true);
    await createAdmin(db, ADMIN_PUBKEY, "Primary admin");
    const app = build();
    await app.ready();

    const filter = encodeURIComponent(JSON.stringify({ pubkey: "%" }));
    const response = await app.inject({
      method: "DELETE",
      url: `/admin/api/admins?filter=${filter}`,
    });

    expect(response.statusCode).toBe(403);
    await expect(getAdmins(db)).resolves.toEqual([
      { pubkey: ADMIN_PUBKEY, name: "Primary admin" },
    ]);
    await app.close();
  });

  test("administrator deletion uses exact pubkeys rather than SQL LIKE patterns", async () => {
    const db = await getDb(true);
    await createAdmin(db, ADMIN_PUBKEY, "Primary admin");
    const secondPubkey = `03${"22".repeat(32)}`;
    await createAdmin(db, secondPubkey, "Second admin");

    await deleteAdmins(db, ["%"]);
    await deleteAdmins(db, [secondPubkey]);

    await expect(getAdmins(db)).resolves.toEqual([
      { pubkey: ADMIN_PUBKEY, name: "Primary admin" },
    ]);
  });

  test("rejects a stale authenticated session after its admin row is gone", async () => {
    const db = await getDb(true);
    const request = {
      session: {
        get: (key: string) => (key === "authenticated" ? true : ADMIN_PUBKEY),
      },
    } as any;
    const reply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    } as any;

    await expect(requireAuthenticatedAdmin(db, request, reply)).resolves.toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
  });
});
