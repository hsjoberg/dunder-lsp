// End-to-end tests: Dunder (in-process) against real lnd nodes on regtest.
// Run with `npm run regtest:up` and then `npm run regtest:test`.
import { randomBytes } from "crypto";
import config from "config";
import Long from "long";
import { FastifyInstance } from "fastify";

import build from "../src/app";
import getDb from "../src/db/db";
import { getChannelRequest } from "../src/db/ondemand-channel";
import { lnrpc } from "../src/proto";
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
  resetMissionControl,
  sendPayment,
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
let lspPubkey: string;
let minimumPaymentSat: number;
const interceptorErrors: string[] = [];

beforeAll(async () => {
  lspPubkey = config.get<string>("regtest.lspPubkey");
  wallet = createClients("wallet");
  payer = createClients("payer");
  walletPubkey = (await getInfo(wallet.lightning)).identityPubkey;

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
    body = { pubkey: walletPubkey, message, signature: await signMessage(wallet.lightning, message) };
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
      const rows = await db.all("SELECT * FROM htlcSettlement WHERE channelId = ?", registration.fakeChannelId);
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

  test("the interceptor stream never dropped during the run", () => {
    expect(interceptorErrors).toEqual([]);
  });
});
