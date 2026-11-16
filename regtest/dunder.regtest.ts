// End-to-end tests: Dunder (in-process) against real lnd nodes on regtest.
// Run with `npm run regtest:up` and then `npm run regtest:test`.
import { createHash, randomBytes } from "crypto";
import config from "config";
import Long from "long";
import { FastifyInstance } from "fastify";

import build from "../src/app";
import getDb from "../src/db/db";
import { getChannelRequest } from "../src/db/ondemand-channel";
import {
  LND_REJECTED_RELEASE_DELAY_MS,
  openChannelForSettledHtlcs,
} from "../src/services/ondemand-channel/channel-open";
import { lnrpc } from "../src/proto";
import {
  FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY,
  forceCloseChannelsWithStalledSettlements,
} from "../src/services/ondemand-channel/settlement-deadline";
import { forceCloseChannel, pendingChannels } from "../src/utils/lnd-api";
import { IRegisterOkResponse } from "../src/services/ondemand-channel/api/register";
import { getServiceDomain } from "../src/services/ondemand-channel/api/signed-request";
import {
  ILndClients,
  addInvoice,
  closeClients,
  connectPeer,
  createClients,
  decodePayReq,
  disconnectPeer,
  getInfo,
  listChannels,
  mine,
  openChannel,
  queryRoutes,
  resetMissionControl,
  runChannelAcceptor,
  sendPayment,
  sendToRoute,
  setNodeFrozen,
  signMessage,
  waitFor,
} from "./lnd";

const FailureCode = lnrpc.Failure.FailureCode;
const PaymentStatus = lnrpc.Payment.PaymentStatus;
const HTLCStatus = lnrpc.HTLCAttempt.HTLCStatus;

let app: FastifyInstance;
let wallet: ILndClients;
let payer: ILndClients;
let walletPubkey: string;
let acceptor: ReturnType<typeof runChannelAcceptor>;
let lspPubkey: string;
let minimumPaymentSat: number;
const interceptorErrors: string[] = [];

beforeAll(async () => {
  lspPubkey = config.get<string>("regtest.lspPubkey");
  wallet = createClients("wallet");
  payer = createClients("payer");
  walletPubkey = (await getInfo(wallet.lightning)).identityPubkey;

  // lnd treats a chain whose newest block is a few hours old as not synced and
  // refuses to open channels, so mine one when the network has sat idle.
  mine(1);
  const lsp = createClients("lsp");
  try {
    for (const node of [lsp, wallet, payer]) {
      await waitFor(
        "lnd to sync to the chain",
        async () => (await getInfo(node.lightning)).syncedToChain,
      );
    }
  } finally {
    closeClients(lsp);
  }
  // An earlier, interrupted run can leave failed opens (which hold payouts back
  // with a backoff) and payments it never paid out (which Dunder's recovery
  // would pay out at startup, spending the LSP's confirmed coins mid-test).
  const db = await getDb();
  await db.run(
    "DELETE FROM channelOpenAttempt WHERE pubkey = ? AND status = 'CANCELLED'",
    walletPubkey,
  );
  await db.run(
    `UPDATE htlcSettlement SET claimed = 1
     WHERE claimed = 0 AND channelOpenAttemptId IS NULL
       AND channelId IN (SELECT channelId FROM channelRequest WHERE pubkey = ?)`,
    walletPubkey,
  );

  // Record any interceptor stream trouble while the tests run.
  const originalError = console.error;
  jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("HTLC interceptor stream")) {
      interceptorErrors.push(args[0]);
    }
    originalError(...args);
  });

  app = build();
  await app.ready();
  // Blixt runs a channel acceptor too.
  acceptor = runChannelAcceptor(wallet.lightning);
  await connectPeer(wallet.lightning, lspPubkey, "lsp:9735");

  const status = (await app.inject({ url: "/ondemand-channel/service-status" })).json();
  if (!Number.isSafeInteger(status.minimumPaymentSat) || status.status !== true) {
    throw new Error(`Dunder service status isn't usable: ${JSON.stringify(status)}`);
  }
  minimumPaymentSat = status.minimumPaymentSat;
  // Let the interceptor stream register with lnd.
  await new Promise((resolve) => setTimeout(resolve, 2000));
});

beforeEach(async () => {
  await resetMissionControl(payer.router);
});

afterAll(async () => {
  acceptor?.stop();
  await app?.close();
  if (wallet) closeClients(wallet);
  if (payer) closeClients(payer);
});

/** Registers an on-demand channel request as the wallet would. */
async function register(amountSat: number, signing: "message" | "legacy" = "message") {
  const preimage = randomBytes(32);
  let body: Record<string, unknown>;
  if (signing === "message") {
    const message = JSON.stringify({
      endpoint: "/ondemand-channel/register",
      domain: getServiceDomain(),
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomBytes(16).toString("hex"),
      data: { amountSat, preimage: preimage.toString("hex") },
    });
    body = {
      pubkey: walletPubkey,
      message,
      signature: await signMessage(wallet.lightning, message),
    };
  } else {
    body = {
      pubkey: walletPubkey,
      signature: await signMessage(wallet.lightning, "REGISTER"),
      preimage: preimage.toString("hex"),
      amountSat,
    };
  }
  const response = await app.inject({
    method: "POST",
    url: "/ondemand-channel/register",
    headers: { "content-type": "text/plain" },
    payload: JSON.stringify(body),
  });
  if (response.statusCode !== 200) {
    throw new Error(`register failed (${response.statusCode}): ${response.body}`);
  }
  return { preimage, registration: response.json() as IRegisterOkResponse };
}

/** Creates the wallet's invoice with Dunder's route hint, as Blixt does. */
async function createInvoice(
  preimage: Buffer,
  registration: IRegisterOkResponse,
  amountSat: number,
) {
  const invoice = await addInvoice(wallet.lightning, {
    rPreimage: preimage,
    value: Long.fromValue(amountSat),
    expiry: Long.fromValue(600),
    routeHints: [
      {
        hopHints: [
          {
            nodeId: registration.servicePubkey,
            chanId: Long.fromString(registration.fakeChannelId, true),
            feeBaseMsat: registration.feeBaseMsat,
            feeProportionalMillionths: registration.feeProportionalMillionths,
            cltvExpiryDelta: registration.cltvExpiryDelta,
          },
        ],
      },
    ],
  });
  return invoice.paymentRequest;
}

function describePayment(payment: lnrpc.Payment) {
  return {
    status: lnrpc.Payment.PaymentStatus[payment.status],
    failureReason: lnrpc.PaymentFailureReason[payment.failureReason],
    htlcFailures: htlcFailureCodes(payment).map((code) => FailureCode[code ?? 0]),
  };
}

function htlcFailureCodes(payment: lnrpc.Payment) {
  return payment.htlcs
    .filter((htlc) => htlc.status === HTLCStatus.FAILED)
    .map((htlc) => htlc.failure?.code);
}

/** Waits for Dunder to open the payout channel, then confirms it. */
async function expectPayout(fakeChannelId: string) {
  const db = await getDb();
  const request = await waitFor(
    "the payout channel",
    async () => {
      const current = await getChannelRequest(db, fakeChannelId);
      return current?.status === "DONE" && current.channelPoint ? current : null;
    },
    90_000,
  );
  const attempt = await db.get<{ pushAmountSat: number; status: string }>(
    "SELECT pushAmountSat, status FROM channelOpenAttempt WHERE channelPoint = ?",
    request.channelPoint,
  );
  expect(attempt?.status).toBe("OPENED");

  // Confirm the funding transaction. The wallet then has an active channel
  // from the LSP holding the pushed amount.
  mine(6);
  const channel = await waitFor("the wallet's channel to become active", async () =>
    (await listChannels(wallet.lightning)).channels.find(
      (c) => c.channelPoint === request.channelPoint && c.active,
    ),
  );
  expect(channel.remotePubkey).toBe(lspPubkey);
  expect(channel.zeroConf).toBe(false);
  expect(Long.fromValue(channel.localBalance ?? 0).toNumber()).toBe(attempt!.pushAmountSat);
  return { channel, pushAmountSat: attempt!.pushAmountSat };
}

function amount(multiple: number) {
  return Math.max(minimumPaymentSat * multiple, 50_000);
}

describe("Dunder on regtest", () => {
  test("a single-part payment is settled and paid out in a new channel", async () => {
    const amountSat = amount(2);
    const { preimage, registration } = await register(amountSat);
    const paymentRequest = await createInvoice(preimage, registration, amountSat);

    const payment = await sendPayment(payer.router, { paymentRequest });

    expect(describePayment(payment)).toMatchObject({ status: "SUCCEEDED" });
    expect(Buffer.from(payment.paymentPreimage, "hex").equals(preimage)).toBe(true);
    const { pushAmountSat } = await expectPayout(registration.fakeChannelId);
    expect(pushAmountSat).toBeGreaterThan(0);
    expect(pushAmountSat).toBeLessThan(amountSat);
  });

  test("a multi-part payment is collected and settled in full", async () => {
    const amountSat = amount(4);
    const { preimage, registration } = await register(amountSat);
    const paymentRequest = await createInvoice(preimage, registration, amountSat);

    const payment = await sendPayment(payer.router, {
      paymentRequest,
      maxShardSizeMsat: Long.fromValue(Math.ceil(amountSat / 3)).mul(1000),
    });

    expect(describePayment(payment)).toMatchObject({ status: "SUCCEEDED" });
    const settledParts = payment.htlcs.filter((htlc) => htlc.status === HTLCStatus.SUCCEEDED);
    expect(settledParts.length).toBeGreaterThanOrEqual(3);
    await expectPayout(registration.fakeChannelId);
  });

  test("a probe with a wrong payment hash fails without dropping the interceptor", async () => {
    const amountSat = amount(2);
    const { preimage, registration } = await register(amountSat);
    const paymentRequest = await createInvoice(preimage, registration, amountSat);
    const decoded = await decodePayReq(payer.lightning, paymentRequest);
    const errorsBefore = interceptorErrors.length;

    const probe = await sendPayment(payer.router, {
      dest: Buffer.from(decoded.destination, "hex"),
      amt: Long.fromValue(amountSat),
      paymentHash: randomBytes(32),
      paymentAddr: decoded.paymentAddr,
      finalCltvDelta: decoded.cltvExpiry.toNumber(),
      routeHints: decoded.routeHints,
      destFeatures: Object.keys(decoded.features).map(Number),
    });

    expect(probe.status).toBe(PaymentStatus.FAILED);
    expect(htlcFailureCodes(probe)).toContain(FailureCode.TEMPORARY_CHANNEL_FAILURE);

    // Paying right after the failed probe: the payer's lnd now avoids the
    // route through Dunder (mission control), so it fails before any HTLC is
    // sent. Real wallets that probe before paying see the same thing.
    const afterProbe = await sendPayment(payer.router, { paymentRequest });
    console.log("Payment right after the failed probe:", describePayment(afterProbe));

    // The interceptor stayed up and the request can still be paid.
    await resetMissionControl(payer.router);
    const payment = await sendPayment(payer.router, { paymentRequest });
    expect(describePayment(payment)).toMatchObject({ status: "SUCCEEDED" });
    expect(interceptorErrors.slice(errorsBefore)).toEqual([]);
    await expectPayout(registration.fakeChannelId);
  });

  test("a payment above the registered amount fails as unknown_next_peer", async () => {
    const amountSat = amount(2);
    const { preimage, registration } = await register(amountSat);
    const paymentRequest = await createInvoice(preimage, registration, amountSat + 10_000);

    const payment = await sendPayment(payer.router, { paymentRequest });

    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(htlcFailureCodes(payment)).toContain(FailureCode.UNKNOWN_NEXT_PEER);
    const db = await getDb();
    expect((await getChannelRequest(db, registration.fakeChannelId))?.status).toBe("REGISTERED");
  });

  test("a payment while the wallet is offline fails and nothing is settled", async () => {
    const amountSat = amount(2);
    const { preimage, registration } = await register(amountSat);
    const paymentRequest = await createInvoice(preimage, registration, amountSat);
    await disconnectPeer(wallet.lightning, lspPubkey);
    try {
      const payment = await sendPayment(payer.router, { paymentRequest });

      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(htlcFailureCodes(payment)).toContain(FailureCode.TEMPORARY_CHANNEL_FAILURE);
      const db = await getDb();
      const rows = await db.all(
        "SELECT * FROM htlcSettlement WHERE channelId = ?",
        registration.fakeChannelId,
      );
      expect(rows).toEqual([]);
    } finally {
      await connectPeer(wallet.lightning, lspPubkey, "lsp:9735");
    }
  });

  test("a wallet using the legacy signature still works", async () => {
    const amountSat = amount(2);
    const { preimage, registration } = await register(amountSat, "legacy");
    const paymentRequest = await createInvoice(preimage, registration, amountSat);

    const payment = await sendPayment(payer.router, { paymentRequest });

    expect(describePayment(payment)).toMatchObject({ status: "SUCCEEDED" });
    await expectPayout(registration.fakeChannelId);
  });

  // Runs last: afterwards the wallet's payouts are in a retry backoff.
  test("a channel open the wallet rejects is released for a later payout", async () => {
    const db = await getDb();
    const amountSat = amount(2);
    const { preimage, registration } = await register(amountSat);
    const paymentRequest = await createInvoice(preimage, registration, amountSat);
    acceptor.rejectFrom(lspPubkey);
    try {
      // The payment itself succeeds; only the payout channel is refused.
      const payment = await sendPayment(payer.router, { paymentRequest });
      expect(describePayment(payment)).toMatchObject({ status: "SUCCEEDED" });

      const failed = await waitFor("the open to fail", () =>
        db
          .get<{ attemptId: string; status: string; failureKind: string; error: string }>(
            `SELECT attemptId, status, failureKind, error FROM channelOpenAttempt
           WHERE attemptId = (SELECT channelOpenAttemptId FROM htlcSettlement WHERE channelId = ? LIMIT 1)`,
            registration.fakeChannelId,
          )
          .then((row) => (row?.status === "UNKNOWN" ? row : null)),
      );
      // lnd answered with the peer's error, so nothing can have been funded.
      expect(failed.failureKind).toBe("LND_REJECTED");
      expect(failed.error).toMatch(/rejected/i);

      // The recovery loop (every 10s) releases it once the delay has passed.
      const released = await waitFor(
        "the failed open to be released",
        () =>
          db
            .get<{ status: string }>(
              "SELECT status FROM channelOpenAttempt WHERE attemptId = ?",
              failed.attemptId,
            )
            .then((row) => (row?.status === "CANCELLED" ? row : null)),
        LND_REJECTED_RELEASE_DELAY_MS + 60_000,
      );
      expect(released.status).toBe("CANCELLED");

      // The settled payment is free to be paid out again (claim, auto-heal or
      // recovery), after the backoff.
      const settlements = await db.all<
        { settled: number; claimed: number; channelOpenAttemptId: string | null }[]
      >(
        "SELECT settled, claimed, channelOpenAttemptId FROM htlcSettlement WHERE channelId = ?",
        registration.fakeChannelId,
      );
      expect(settlements.length).toBeGreaterThan(0);
      expect(settlements.every((row) => row.settled === 1 && row.claimed === 0)).toBe(true);
      expect(settlements.every((row) => row.channelOpenAttemptId === null)).toBe(true);
      await expect(
        openChannelForSettledHtlcs({
          db,
          lightning: {} as any,
          pubkey: walletPubkey,
          source: "CLAIM",
          zeroConf: false,
          taprootChannel: true,
        }),
      ).resolves.toMatchObject({ status: "BACKOFF" });
    } finally {
      acceptor.acceptFrom(lspPubkey);
      // Test data only: drop this request and the failed attempt so the next
      // run doesn't start in the backoff or pay this request out.
      await db.run("DELETE FROM htlcSettlement WHERE channelId = ?", registration.fakeChannelId);
      await db.run(
        "UPDATE channelRequest SET status = 'DONE', automaticOpenQueued = 0 WHERE channelId = ?",
        registration.fakeChannelId,
      );
      await db.run(
        "DELETE FROM channelOpenAttempt WHERE pubkey = ? AND status = 'CANCELLED'",
        walletPubkey,
      );
    }
  });

  test("an HTLC whose onion forwards more than the HTLC carries is not settled", async () => {
    const amountSat = amount(2);
    const { preimage, registration } = await register(amountSat);
    const paymentRequest = await createInvoice(preimage, registration, amountSat);
    const decoded = await decodePayReq(payer.lightning, paymentRequest);

    const { routes } = await queryRoutes(payer.lightning, {
      pubKey: walletPubkey,
      amt: Long.fromValue(amountSat),
      finalCltvDelta: decoded.cltvExpiry.toNumber(),
      routeHints: decoded.routeHints,
      useMissionControl: false,
    });
    const route = routes[0] as lnrpc.Route;
    expect(route.hops.map((hop) => hop.pubKey)).toEqual([lspPubkey, walletPubkey]);
    const lastHop = route.hops[1] as lnrpc.Hop;
    expect(Long.fromValue(lastHop.chanId).toString()).toBe(registration.fakeChannelId);
    lastHop.tlvPayload = true;
    lastHop.mppRecord = {
      paymentAddr: decoded.paymentAddr,
      totalAmtMsat: Long.fromValue(amountSat).mul(1000),
    };
    console.log("Honest route", {
      htlcToLspMsat: Long.fromValue(route.totalAmtMsat).toString(),
      lspForwardsMsat: Long.fromValue(route.hops[0].amtToForwardMsat ?? 0).toString(),
    });

    // The forgery: the HTLC sent to the LSP carries 1 sat, while the LSP's
    // onion payload still tells it to forward the full amount over the fake
    // channel ID. The payer builds the onion, so nothing stops it doing this.
    route.totalAmtMsat = Long.fromValue(1000);
    route.totalAmt = Long.fromValue(1);
    route.totalFeesMsat = Long.fromValue(0);
    route.totalFees = Long.fromValue(0);

    const payerBalance = async () =>
      (await listChannels(payer.lightning)).channels
        .filter((channel) => channel.remotePubkey === lspPubkey)
        .reduce((sum, channel) => sum + Long.fromValue(channel.localBalance ?? 0).toNumber(), 0);
    const balanceBefore = await payerBalance();

    const attempt = await sendToRoute(payer.router, {
      paymentHash: Buffer.from(decoded.paymentHash, "hex"),
      route,
    });

    const db = await getDb();
    const settlements = await db.all<{ amountSat: number }[]>(
      "SELECT amountSat FROM htlcSettlement WHERE channelId = ?",
      registration.fakeChannelId,
    );
    console.log("Forged HTLC result", {
      attempt: HTLCStatus[attempt.status],
      failure: attempt.failure ? FailureCode[attempt.failure.code ?? 0] : null,
      htlcSentMsat: Long.fromValue(attempt.route?.totalAmtMsat ?? 0).toString(),
      payerPaidSat: balanceBefore - (await payerBalance()),
      dunderRecordedSat: settlements.reduce((sum, row) => sum + row.amountSat, 0),
    });

    if (attempt.status === HTLCStatus.SUCCEEDED) {
      // Show the whole loss: Dunder pays the forged amount out to the wallet.
      const { pushAmountSat } = await expectPayout(registration.fakeChannelId);
      console.log("Dunder pushed to the wallet (sat):", pushAmountSat);
    }

    expect(HTLCStatus[attempt.status]).toBe("FAILED");
    expect(settlements).toEqual([]);
  });

  describe("payer channels that go on-chain (these close and reopen the payer's channel)", () => {
    let lsp: ILndClients;
    let payerPubkey: string;

    beforeAll(async () => {
      lsp = createClients("lsp");
      payerPubkey = (await getInfo(payer.lightning)).identityPubkey;
    });
    afterAll(() => {
      closeClients(lsp);
    });

    const payerChannelOnLsp = async () =>
      (await listChannels(lsp.lightning)).channels.find(
        (channel) => channel.remotePubkey === payerPubkey,
      ) as lnrpc.Channel | undefined;

    /**
     * Sends one part of a multi-part payment from the payer, over a hand-built
     * route, and waits until the LSP has locked it in. It doesn't wait for the
     * payment's outcome (the payer may be frozen).
     */
    async function sendPayerPart(
      registration: IRegisterOkResponse,
      paymentHash: Buffer,
      paymentAddr: Buffer,
      partSat: number,
      totalSat: number,
    ) {
      const fakeChanId = Long.fromString(registration.fakeChannelId, true);
      const { routes } = await queryRoutes(payer.lightning, {
        pubKey: walletPubkey,
        amt: Long.fromValue(partSat),
        finalCltvDelta: 20,
        routeHints: [
          {
            hopHints: [
              {
                nodeId: registration.servicePubkey,
                chanId: fakeChanId,
                feeBaseMsat: registration.feeBaseMsat,
                feeProportionalMillionths: registration.feeProportionalMillionths,
                cltvExpiryDelta: registration.cltvExpiryDelta,
              },
            ],
          },
        ],
        useMissionControl: false,
      });
      const route = routes[0] as lnrpc.Route;
      Object.assign(route.hops[1], {
        chanId: fakeChanId,
        tlvPayload: true,
        mppRecord: { paymentAddr, totalAmtMsat: Long.fromValue(totalSat).mul(1000) },
      });
      sendToRoute(payer.router, { paymentHash, route }).catch(() => undefined);
      const channel = await waitFor("the payer's part to be locked in on the LSP", async () => {
        const current = await payerChannelOnLsp();
        return current?.pendingHtlcs?.length === 1 ? current : null;
      });
      return { channel, htlc: channel.pendingHtlcs[0] as lnrpc.HTLC };
    }

    /** Unfreezes the payer and gives it a new channel to the LSP. */
    async function restorePayerChannel() {
      setNodeFrozen("payer", false);
      await waitFor(
        "the payer to sync",
        async () => (await getInfo(payer.lightning)).syncedToChain,
        300_000,
      );
      if ((await payerChannelOnLsp())?.active) {
        return;
      }
      await connectPeer(payer.lightning, lspPubkey, "lsp:9735");
      await openChannel(payer.lightning, lspPubkey, 5_000_000);
      mine(6);
      // Both sides must see it active before the payer can route over it.
      await waitFor("the payer's new channel to become active", async () => {
        const payerSide = (await listChannels(payer.lightning)).channels.find(
          (channel) => channel.remotePubkey === lspPubkey && channel.active,
        );
        return payerSide && (await payerChannelOnLsp())?.active;
      });
      // An active channel isn't usable for a payment right away ("insufficient
      // local balance" from QueryRoutes until lnd's link is ready).
      await waitFor("the payer to be able to route over it", async () => {
        try {
          await queryRoutes(payer.lightning, { pubKey: lspPubkey, amt: Long.fromValue(100_000) });
          return true;
        } catch {
          return false;
        }
      });
      await resetMissionControl(payer.router);
    }

    test("an HTLC offered again after its channel went on-chain doesn't drop the interceptor", async () => {
      const errorsBefore = interceptorErrors.length;
      const warn = jest.spyOn(console, "warn");
      try {
        const { preimage, registration } = await register(100_000);
        const paymentHash = createHash("sha256").update(preimage).digest();
        // Half of the payment: Dunder holds it while it waits for the rest.
        const { channel } = await sendPayerPart(
          registration,
          paymentHash,
          randomBytes(32),
          50_000,
          100_000,
        );

        // The channel goes on-chain while the part is held. lnd offers the
        // HTLC to the interceptor again and accepts only SETTLE for it; when
        // Dunder's hold times out, failing it would end the stream, again and
        // again on every reconnect.
        await forceCloseChannel(lsp.lightning, channel.channelPoint);
        mine(1);
        await new Promise((resolve) =>
          setTimeout(resolve, (config.get<number>("htlcWaitSeconds") + 5) * 1000),
        );

        expect(interceptorErrors.slice(errorsBefore)).toEqual([]);
        // Dunder's FAIL was held back: either the part's channel had already
        // closed, or lnd had offered it again as an on-chain HTLC.
        const warnings = warn.mock.calls.map((call) => call[0]);
        expect(warnings).toEqual(
          expect.arrayContaining([
            expect.stringMatching(
              /^(Not answering a held part whose channel has closed|Leaving an on-chain HTLC unanswered)/,
            ),
          ]),
        );
      } finally {
        warn.mockRestore();
        await restorePayerChannel();
      }
    });

    test("a part the payer never locks in is claimed on-chain before it is paid out", async () => {
      const db = await getDb();
      const amountSat = 100_000;
      const walletPartSat = 10_000;
      const { preimage, registration } = await register(amountSat);
      const paymentHash = createHash("sha256").update(preimage).digest();
      const paymentAddr = randomBytes(32);
      const fakeChanId = Long.fromString(registration.fakeChannelId, true);
      try {
        // Part 1 from the payer, then the payer stops responding.
        const { channel, htlc } = await sendPayerPart(
          registration,
          paymentHash,
          paymentAddr,
          amountSat - walletPartSat,
          amountSat,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        setNodeFrozen("payer", true);

        // Part 2 from the wallet, over one of its payout channels from the
        // LSP. Dunder settles both parts: the payer now has the preimage, but
        // never locks the settlement in.
        const walletChannel = (await listChannels(wallet.lightning)).channels
          .filter((c) => c.remotePubkey === lspPubkey && c.active)
          .sort((a, b) =>
            Long.fromValue(b.localBalance!).compare(Long.fromValue(a.localBalance!)),
          )[0];
        const height = (await getInfo(wallet.lightning)).blockHeight;
        const partMsat = Long.fromValue(walletPartSat).mul(1000);
        const feeMsat = Long.fromValue(2000);
        const finalExpiry = height + 43;
        const walletAttempt = await sendToRoute(wallet.router, {
          paymentHash,
          route: {
            totalTimeLock: finalExpiry + registration.cltvExpiryDelta,
            totalAmtMsat: partMsat.add(feeMsat),
            totalFeesMsat: feeMsat,
            hops: [
              {
                chanId: Long.fromValue(walletChannel.chanId!),
                pubKey: lspPubkey,
                amtToForwardMsat: partMsat,
                feeMsat,
                expiry: finalExpiry,
                tlvPayload: true,
              },
              {
                chanId: fakeChanId,
                pubKey: walletPubkey,
                amtToForwardMsat: partMsat,
                feeMsat: Long.fromValue(0),
                expiry: finalExpiry,
                tlvPayload: true,
                mppRecord: { paymentAddr, totalAmtMsat: Long.fromValue(amountSat).mul(1000) },
              },
            ],
          },
        });
        expect(Buffer.from(walletAttempt.preimage).equals(preimage)).toBe(true);

        // No payout: lnd hasn't reported a final outcome for the payer's part.
        await new Promise((resolve) => setTimeout(resolve, 5000));
        expect(await getChannelRequest(db, registration.fakeChannelId)).toMatchObject({
          status: "REGISTERED",
          channelPoint: null,
        });

        // Shortly before the HTLC expires, Dunder force-closes the channel.
        const target = htlc.expirationHeight - FORCE_CLOSE_BLOCKS_BEFORE_EXPIRY;
        mine(Math.max(0, target - (await getInfo(lsp.lightning)).blockHeight));
        await waitFor("the LSP to reach the deadline", async () => {
          const info = await getInfo(lsp.lightning);
          return info.syncedToChain && info.blockHeight >= target;
        });
        // console.error is already a spy (see beforeAll); read its calls.
        const errorCalls = (console.error as jest.Mock).mock.calls;
        const errorsBefore = errorCalls.length;
        await forceCloseChannelsWithStalledSettlements(db, lsp.lightning);
        await waitFor("the payer's channel to close", async () => !(await payerChannelOnLsp()));

        // lnd offers the HTLC to the interceptor again, Dunder settles it, and
        // lnd claims it on-chain. lnd gives up on the HTLC once its expiry is
        // reached, so blocks come one at a time here, as on a real chain where
        // these 18 blocks take about three hours.
        await waitFor(
          "lnd to claim the payer's HTLC on-chain",
          async () => {
            mine(1);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const { pendingForceClosingChannels } = await pendingChannels(lsp.lightning);
            return pendingForceClosingChannels.some(
              (closing) =>
                closing.channel?.channelPoint === channel.channelPoint &&
                (closing.pendingHtlcs ?? []).some((pending) => pending.stage === 2),
            );
          },
          120_000,
        );
        expect(errorCalls.slice(errorsBefore)).toContainEqual([
          "A settled HTLC came back on-chain; settling it so lnd claims it",
          expect.objectContaining({ circuitKey: `${channel.chanId}:${htlc.htlcIndex}` }),
        ]);

        // lnd's final outcome comes after the claim's timelock (the payer's
        // channel sets 600 blocks); only then does Dunder pay out.
        // Mine quickly to just before the claim matures, then one block at a
        // time with lnd synced, so the payout channel it then opens isn't
        // refused with "wallet not fully synced".
        const claimMaturity = async () => {
          const { pendingForceClosingChannels } = await pendingChannels(lsp.lightning);
          const closing = pendingForceClosingChannels.find(
            (pending) => pending.channel?.channelPoint === channel.channelPoint,
          );
          return (closing?.pendingHtlcs ?? []).find((pending) => pending.stage === 2)
            ?.blocksTilMaturity;
        };
        const blocksLeft = (await claimMaturity()) ?? 0;
        if (blocksLeft > 3) {
          mine(blocksLeft - 3);
        }
        await waitFor(
          "lnd's final outcome for the payer's part",
          async () => {
            mine(1);
            await waitFor(
              "the LSP to sync",
              async () => (await getInfo(lsp.lightning)).syncedToChain,
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const rows = await db.all<{ settled: number }[]>(
              "SELECT settled FROM htlcSettlement WHERE channelId = ?",
              registration.fakeChannelId,
            );
            return rows.length === 2 && rows.every((row) => row.settled === 1);
          },
          600_000,
        );
        const { pushAmountSat } = await expectPayout(registration.fakeChannelId);
        expect(pushAmountSat).toBeGreaterThan(0);
      } finally {
        await restorePayerChannel();
      }
      // Mines through the claim's timelock (the payer's channel sets 600 blocks).
    }, 900_000);
  });

  test("the interceptor stream never dropped during the run", () => {
    expect(interceptorErrors).toEqual([]);
  });
});
