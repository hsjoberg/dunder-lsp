import Long from "long";
import { getUnixTime } from "date-fns";

import getDb from "../../../../src/db/db";
import {
  createChannelRequest,
  getHtlcSettlementByCircuitKey,
} from "../../../../src/db/ondemand-channel";
import {
  createOnDemandChannelHtlcHandler,
  dropHeldPaymentsAfterStreamReset,
  handleHtlcFailed,
  handleHtlcSettled,
  REQUEST_EXPIRY_GRACE_SECONDS,
} from "../../../../src/services/ondemand-channel/api/register";
import { HtlcResponseWriter } from "../../../../src/services/htlc-interceptor";
import { routerrpc } from "../../../../src/proto";
import { bytesToHexString, sha256Buffer } from "../../../../src/utils/common";
import { MSAT } from "../../../../src/utils/constants";
import { createPreimage } from "./register-helpers";

import {
  __MOCK_BLOCK_HEIGHT,
  checkPeerConnected,
  openChannelSync,
} from "../../../../mocks/utils/lnd-api";

const PUBKEY = "abcdef12345";
const SETTLE = routerrpc.ResolveHoldForwardAction.SETTLE;
const FAIL = routerrpc.ResolveHoldForwardAction.FAIL;
// lnd fails a resumed HTLC to a fake channel ID with unknown_next_peer.
const RESUME = routerrpc.ResolveHoldForwardAction.RESUME;

let channelCounter = 0;

type RecordingWriter = HtlcResponseWriter & {
  actions: routerrpc.ResolveHoldForwardAction[];
  failureCodes: (number | undefined)[];
};

function writer(onRespond?: (action: routerrpc.ResolveHoldForwardAction) => void): RecordingWriter {
  const actions: routerrpc.ResolveHoldForwardAction[] = [];
  const failureCodes: (number | undefined)[] = [];
  return {
    actions,
    failureCodes,
    get responded() {
      return actions.length > 0;
    },
    respond(action, _key, _preimage, failureCode) {
      actions.push(action);
      failureCodes.push(failureCode);
      onRespond?.(action);
    },
  };
}

async function setup(
  options: { amountSat?: number; start?: number; status?: "REGISTERED" | "DONE" } = {},
) {
  const db = await getDb(true);
  const channelId = String(900_000 + ++channelCounter);
  const preimage = createPreimage(channelCounter);
  await createChannelRequest(db, {
    channelId,
    pubkey: PUBKEY,
    preimage: bytesToHexString(preimage),
    status: options.status ?? "REGISTERED",
    start: options.start ?? getUnixTime(new Date()),
    expire: 600,
    expectedAmountSat: options.amountSat ?? 20_000,
    channelPoint: null,
  });
  const handler = createOnDemandChannelHtlcHandler(db, {} as any);
  const htlc = (
    amountSat: number,
    chanId: string,
    htlcId: string,
    expiry: { incomingExpiry?: number; autoFailHeight?: number } = {
      incomingExpiry: __MOCK_BLOCK_HEIGHT + 200,
      autoFailHeight: __MOCK_BLOCK_HEIGHT + 187,
    },
    paymentHash: Uint8Array = sha256Buffer(preimage),
    incomingAmountMsat: Long = Long.fromValue(amountSat).mul(MSAT),
  ) =>
    routerrpc.ForwardHtlcInterceptRequest.create({
      outgoingAmountMsat: Long.fromValue(amountSat).mul(MSAT),
      incomingAmountMsat,
      incomingCircuitKey: routerrpc.CircuitKey.create({
        chanId: Long.fromString(chanId, true),
        htlcId: Long.fromString(htlcId, true),
      }),
      paymentHash,
      outgoingRequestedChanId: Long.fromString(channelId, true),
      ...expiry,
    });
  return { db, channelId, handler, htlc };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("held multi-part payments", () => {
  beforeEach(() => {
    (openChannelSync as jest.Mock).mockClear();
  });

  test("a part lnd sends again is counted once and answered on the live stream", async () => {
    const { handler, htlc } = await setup();
    const oldStream = writer();
    const newStream = writer();
    const second = writer();

    await handler(htlc(10_000, "1", "1"), oldStream);
    // Same circuit key again (lnd replays held HTLCs to a new stream).
    await handler(htlc(10_000, "1", "1"), newStream);
    // Counted twice this would already add up to 20 000 sat and settle.
    expect(newStream.actions).toEqual([]);

    await handler(htlc(10_000, "2", "1"), second);
    await waitFor(() => second.actions.length > 0);

    expect(oldStream.actions).toEqual([]);
    expect(newStream.actions).toEqual([SETTLE]);
    expect(second.actions).toEqual([SETTLE]);
  });

  test("records every part in the database before sending SETTLE", async () => {
    const { db, handler, htlc } = await setup();
    const rowsAtSettle: (unknown | undefined)[] = [];
    const check = (chanId: string) =>
      writer((action) => {
        if (action === SETTLE) {
          rowsAtSettle.push(getHtlcSettlementByCircuitKey(db, chanId, "7"));
        }
      });
    const a = check("11");
    const b = check("12");

    await handler(htlc(5_000, "11", "7"), a);
    await handler(htlc(15_000, "12", "7"), b);
    await waitFor(() => a.actions.length > 0 && b.actions.length > 0);

    const rows = await Promise.all(rowsAtSettle);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !!row)).toBe(true);
  });

  test("a part that lnd sends again after SETTLE is settled again from the database", async () => {
    const { handler, htlc } = await setup({ amountSat: 10_000 });
    const first = writer();
    await handler(htlc(10_000, "21", "3"), first);
    await waitFor(() => first.actions.length > 0);

    const replay = writer();
    await handler(htlc(10_000, "21", "3"), replay);

    expect(first.actions).toEqual([SETTLE]);
    expect(replay.actions).toEqual([SETTLE]);
  });

  test("a part that would exceed the expected amount is failed on its own (unknown_next_peer)", async () => {
    const { handler, htlc } = await setup();
    const a = writer();
    const tooMuch = writer();
    const b = writer();

    await handler(htlc(15_000, "31", "1"), a);
    await handler(htlc(10_000, "32", "1"), tooMuch);
    expect(tooMuch.actions).toEqual([RESUME]);
    expect(a.actions).toEqual([]);

    await handler(htlc(5_000, "33", "1"), b);
    await waitFor(() => a.actions.length > 0 && b.actions.length > 0);
    expect(a.actions).toEqual([SETTLE]);
    expect(b.actions).toEqual([SETTLE]);
  });

  test("parts are dropped (not answered) when the interceptor stream resets", async () => {
    const { handler, htlc } = await setup();
    const released = writer();
    await handler(htlc(10_000, "41", "1"), released);

    dropHeldPaymentsAfterStreamReset();

    // The released part no longer counts towards the total.
    const other = writer();
    await handler(htlc(10_000, "42", "1"), other);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(released.actions).toEqual([]);
    expect(other.actions).toEqual([]);
  });

  test("a payment for an expired request is failed (unknown_next_peer)", async () => {
    const { handler, htlc } = await setup({
      start: getUnixTime(new Date()) - 600 - REQUEST_EXPIRY_GRACE_SECONDS - 1,
    });
    const part = writer();
    await handler(htlc(20_000, "51", "1"), part);
    expect(part.actions).toEqual([RESUME]);
  });

  test("a payment within the expiry grace period is accepted", async () => {
    const { handler, htlc } = await setup({
      start: getUnixTime(new Date()) - 600 - REQUEST_EXPIRY_GRACE_SECONDS + 30,
    });
    const part = writer();
    await handler(htlc(20_000, "52", "1"), part);
    await waitFor(() => part.actions.length > 0);
    expect(part.actions).toEqual([SETTLE]);
  });

  test("a payment for a request that is already done is failed", async () => {
    const { handler, htlc } = await setup({ status: "DONE" });
    const part = writer();
    await handler(htlc(20_000, "61", "1"), part);
    expect(part.actions).toEqual([RESUME]);
  });

  test("a new payment for a request that was already paid is failed", async () => {
    const { handler, htlc } = await setup({ amountSat: 10_000 });
    const paid = writer();
    await handler(htlc(10_000, "71", "1"), paid);
    await waitFor(() => paid.actions.length > 0);

    const again = writer();
    await handler(htlc(10_000, "72", "1"), again);
    expect(again.actions).toEqual([RESUME]);
  });

  test("settle events mark the rows settled and open the channel", async () => {
    const { db, handler, htlc } = await setup({ amountSat: 10_000 });
    const part = writer();
    await handler(htlc(10_000, "81", "1"), part);
    await waitFor(() => part.actions.length > 0);

    await handleHtlcSettled(db, {} as any, "81", "1");

    expect((await getHtlcSettlementByCircuitKey(db, "81", "1"))?.settled).toBe(1);
    expect(openChannelSync).toBeCalledTimes(1);
  });

  test("an HTLC lnd failed instead of settling has its record removed", async () => {
    const { db, handler, htlc } = await setup({ amountSat: 10_000 });
    const part = writer();
    await handler(htlc(10_000, "91", "1"), part);
    await waitFor(() => part.actions.length > 0);

    await handleHtlcFailed(db, "91", "1");

    expect(await getHtlcSettlementByCircuitKey(db, "91", "1")).toBeUndefined();
  });

  test("channel IDs above 2^53 are stored exactly", async () => {
    const { db, handler, htlc } = await setup({ amountSat: 10_000 });
    // Outputs 0 and 1 of the same funding transaction at block 870000. As
    // JavaScript numbers these two IDs are equal.
    const a = writer();
    const b = writer();
    await handler(htlc(4_000, "956575116245991424", "5"), a);
    await handler(htlc(6_000, "956575116245991425", "5"), b);
    await waitFor(() => a.actions.length > 0 && b.actions.length > 0);

    expect(a.actions).toEqual([SETTLE]);
    expect(b.actions).toEqual([SETTLE]);
    expect((await getHtlcSettlementByCircuitKey(db, "956575116245991424", "5"))?.amountSat).toBe(
      4_000,
    );
    expect((await getHtlcSettlementByCircuitKey(db, "956575116245991425", "5"))?.amountSat).toBe(
      6_000,
    );
  });
  test("an HTLC too close to lnd's auto-fail height is failed instead of held", async () => {
    const { handler, htlc } = await setup();
    const part = writer();
    await handler(
      htlc(10_000, "101", "1", {
        incomingExpiry: __MOCK_BLOCK_HEIGHT + 19,
        autoFailHeight: __MOCK_BLOCK_HEIGHT + 6,
      }),
      part,
    );
    expect(part.actions).toEqual([FAIL]);
  });

  test("an HTLC with enough blocks left is held", async () => {
    const { handler, htlc } = await setup();
    const part = writer();
    await handler(
      htlc(10_000, "102", "1", {
        incomingExpiry: __MOCK_BLOCK_HEIGHT + 20,
        autoFailHeight: __MOCK_BLOCK_HEIGHT + 7,
      }),
      part,
    );
    expect(part.actions).toEqual([]);
  });

  test("without lnd's auto-fail height, it is derived from the incoming expiry", async () => {
    const { handler, htlc } = await setup();
    const part = writer();
    await handler(htlc(10_000, "103", "1", { incomingExpiry: __MOCK_BLOCK_HEIGHT + 19 }), part);
    expect(part.actions).toEqual([FAIL]);
  });

  test("a second full payment that raced past the paid check is failed back", async () => {
    const { db, channelId, handler, htlc } = await setup({ amountSat: 10_000 });
    // Hold the second payment's handler after it has read "not paid".
    let release!: () => void;
    let reached!: () => void;
    const reachedPeerCheck = new Promise<void>((resolve) => (reached = resolve));
    (checkPeerConnected as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          reached();
          release = () => resolve(true);
        }),
    );
    const second = writer();
    const secondHandled = handler(htlc(10_000, "108", "1"), second);
    await reachedPeerCheck;

    // The first payment is collected, recorded and settled meanwhile.
    const first = writer();
    await handler(htlc(10_000, "107", "1"), first);
    await waitFor(() => first.actions.length > 0);
    expect(first.actions).toEqual([SETTLE]);

    release();
    await secondHandled;
    await waitFor(() => second.actions.length > 0);
    // Failed back to the payer, not settled and not recorded.
    expect(second.actions).toEqual([FAIL]);
    const rows = await db.all(
      "SELECT incomingChannelId FROM htlcSettlement WHERE channelId = ?",
      channelId,
    );
    expect(rows).toEqual([{ incomingChannelId: "107" }]);
  });

  test("a wrong payment hash is failed with a code lnd accepts", async () => {
    const { handler, htlc } = await setup();
    const part = writer();
    await handler(htlc(20_000, "104", "1", undefined, new Uint8Array(32)), part);
    expect(part.actions).toEqual([FAIL]);
    // No failure code: lnd uses TEMPORARY_CHANNEL_FAILURE. lnd rejects
    // INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS and drops the interceptor stream.
    expect(part.failureCodes).toEqual([undefined]);
  });

  test("an HTLC carrying less than its onion says to forward is failed", async () => {
    const { db, handler, htlc } = await setup({ amountSat: 20_000 });
    const part = writer();
    // 1 sat received, 20 000 sat to forward according to the payer's onion.
    await handler(htlc(20_000, "105", "1", undefined, undefined, Long.fromValue(1_000)), part);
    expect(part.actions).toEqual([FAIL]);
    expect(await getHtlcSettlementByCircuitKey(db, "105", "1")).toBeUndefined();
    expect(openChannelSync).not.toHaveBeenCalled();
  });

  test("an HTLC carrying more than it forwards (the route hint fee) is accepted", async () => {
    const { handler, htlc } = await setup({ amountSat: 20_000 });
    const part = writer();
    await handler(
      htlc(20_000, "106", "1", undefined, undefined, Long.fromValue(20_000_051)),
      part,
    );
    await waitFor(() => part.actions.length > 0);
    expect(part.actions).toEqual([SETTLE]);
  });
});
