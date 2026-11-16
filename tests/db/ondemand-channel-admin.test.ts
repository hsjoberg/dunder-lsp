import getDb from "../../src/db/db";
import { createChannelRequest, createHtlcSettlement } from "../../src/db/ondemand-channel";
import { getHtlcSettlementByAdminId } from "../../src/db/ondemand-channel-admin";

describe("getHtlcSettlementByAdminId", () => {
  test("finds a settlement by channelId-incomingChannelId-htlcId", async () => {
    const db = await getDb(true);
    await createChannelRequest(db, {
      channelId: "3491392815",
      pubkey: "abcdef",
      preimage: "aa",
      status: "REGISTERED",
      start: 0,
      expire: 600,
      expectedAmountSat: 2000,
      channelPoint: null,
    });
    // Two parts of the same payment, and a 64-bit incoming channel ID.
    for (const htlcId of ["4943", "4944"]) {
      await createHtlcSettlement(db, {
        channelId: "3491392815",
        incomingChannelId: "18446744073709551615",
        htlcId,
        amountSat: 1000,
        settled: 1,
        claimed: 0,
      });
    }

    const settlement = await getHtlcSettlementByAdminId(db, "3491392815-18446744073709551615-4944");
    expect(settlement).toMatchObject({
      channelId: "3491392815",
      incomingChannelId: "18446744073709551615",
      htlcId: "4944",
    });

    expect(
      await getHtlcSettlementByAdminId(db, "3491392815-18446744073709551615-1"),
    ).toBeUndefined();
    expect(await getHtlcSettlementByAdminId(db, "3491392815")).toBeUndefined();
    expect(await getHtlcSettlementByAdminId(db, "1' OR '1'='1")).toBeUndefined();
  });
});
