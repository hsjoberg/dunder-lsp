// Small lnd client for the regtest tests (wallet and payer nodes).
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { Client, credentials, Metadata } from "@grpc/grpc-js";
import config from "config";
import Long from "long";

import { lnrpc, routerrpc } from "../src/proto";
import { grpcChannelOptionsFor } from "../src/utils/grpc";

export type RegtestNode = "lsp" | "wallet" | "payer";

export interface ILndClients {
  lightning: Client;
  router: Client;
}

export function createClients(node: RegtestNode): ILndClients {
  const { grpcServer, cert, macaroon } = config.get<{
    grpcServer: string;
    cert: string;
    macaroon: string;
  }>(`regtest.nodes.${node}`);
  const macaroonHex = fs.readFileSync(macaroon).toString("hex");
  const macaroonCreds = credentials.createFromMetadataGenerator((_args, callback) => {
    const metadata = new Metadata();
    metadata.add("macaroon", macaroonHex);
    callback(null, metadata);
  });
  const creds = credentials.combineChannelCredentials(
    credentials.createSsl(fs.readFileSync(cert)),
    macaroonCreds,
  );
  const options = grpcChannelOptionsFor(grpcServer);
  return {
    lightning: new Client(grpcServer, creds, options),
    router: new Client(grpcServer, creds, options),
  };
}

export function closeClients(clients: ILndClients) {
  clients.lightning.close();
  clients.router.close();
}

function unary<T>(
  client: Client,
  method: string,
  request: Uint8Array,
  decode: (data: Uint8Array) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    client.makeUnaryRequest(
      method,
      (arg: any) => arg,
      (arg: any) => arg,
      request,
      (error, response) => (error ? reject(error) : resolve(decode(response))),
    );
  });
}

export function getInfo(lightning: Client) {
  return unary(
    lightning,
    "/lnrpc.Lightning/GetInfo",
    lnrpc.GetInfoRequest.encode({}).finish(),
    lnrpc.GetInfoResponse.decode,
  );
}

export async function signMessage(lightning: Client, message: string) {
  const response = await unary(
    lightning,
    "/lnrpc.Lightning/SignMessage",
    lnrpc.SignMessageRequest.encode({ msg: Buffer.from(message, "utf8") }).finish(),
    lnrpc.SignMessageResponse.decode,
  );
  return response.signature;
}

export function addInvoice(lightning: Client, invoice: lnrpc.IInvoice) {
  return unary(
    lightning,
    "/lnrpc.Lightning/AddInvoice",
    lnrpc.Invoice.encode(invoice).finish(),
    lnrpc.AddInvoiceResponse.decode,
  );
}

export function decodePayReq(lightning: Client, payReq: string) {
  return unary(
    lightning,
    "/lnrpc.Lightning/DecodePayReq",
    lnrpc.PayReqString.encode({ payReq }).finish(),
    lnrpc.PayReq.decode,
  );
}

export function listChannels(lightning: Client) {
  return unary(
    lightning,
    "/lnrpc.Lightning/ListChannels",
    lnrpc.ListChannelsRequest.encode({}).finish(),
    lnrpc.ListChannelsResponse.decode,
  );
}

export function listPeers(lightning: Client) {
  return unary(
    lightning,
    "/lnrpc.Lightning/ListPeers",
    lnrpc.ListPeersRequest.encode({}).finish(),
    lnrpc.ListPeersResponse.decode,
  );
}

export async function connectPeer(lightning: Client, pubkey: string, host: string) {
  const peers = await listPeers(lightning);
  if (peers.peers.some((peer) => peer.pubKey === pubkey)) {
    return;
  }
  await unary(
    lightning,
    "/lnrpc.Lightning/ConnectPeer",
    lnrpc.ConnectPeerRequest.encode({ addr: { pubkey, host }, perm: false }).finish(),
    lnrpc.ConnectPeerResponse.decode,
  );
}

export async function disconnectPeer(lightning: Client, pubkey: string) {
  await unary(
    lightning,
    "/lnrpc.Lightning/DisconnectPeer",
    lnrpc.DisconnectPeerRequest.encode({ pubKey: pubkey }).finish(),
    lnrpc.DisconnectPeerResponse.decode,
  );
}

/**
 * Clears the payer's record of past failures. lnd stops trying a route after a
 * failure on it, so later payments in a test run would otherwise fail with
 * "no route" before reaching Dunder.
 */
export async function resetMissionControl(router: Client) {
  await unary(
    router,
    "/routerrpc.Router/ResetMissionControl",
    routerrpc.ResetMissionControlRequest.encode({}).finish(),
    routerrpc.ResetMissionControlResponse.decode,
  );
}

/** SendPaymentV2; resolves with the final payment state. */
export function sendPayment(
  router: Client,
  request: routerrpc.ISendPaymentRequest,
): Promise<lnrpc.Payment> {
  return new Promise((resolve, reject) => {
    const stream = router.makeServerStreamRequest(
      "/routerrpc.Router/SendPaymentV2",
      (arg: any) => arg,
      (arg: any) => arg,
      routerrpc.SendPaymentRequest.encode({
        timeoutSeconds: 60,
        feeLimitSat: Long.fromValue(10_000),
        ...request,
      }).finish(),
      new Metadata(),
      undefined,
    );
    stream.on("data", (data: Uint8Array) => {
      const payment = lnrpc.Payment.decode(data);
      if (
        payment.status === lnrpc.Payment.PaymentStatus.SUCCEEDED ||
        payment.status === lnrpc.Payment.PaymentStatus.FAILED
      ) {
        stream.cancel();
        resolve(payment);
      }
    });
    stream.on("error", (error: any) => {
      // Cancelling after the final update raises CANCELLED; ignore that one.
      if (error?.code !== 1) {
        reject(error);
      }
    });
  });
}

/**
 * A channel acceptor like Blixt's: refuse legacy commitment types and
 * zero-conf channels, accept anchor and taproot channels. `rejectFrom` makes it
 * refuse every channel from a peer (to simulate a wallet rejecting the open).
 */
export function runChannelAcceptor(lightning: Client) {
  const rejectedPeers = new Set<string>();
  const stream = lightning.makeBidiStreamRequest(
    "/lnrpc.Lightning/ChannelAcceptor",
    (arg: any) => arg,
    (arg: any) => arg,
    new Metadata(),
    undefined,
  );
  stream.on("data", (data: Uint8Array) => {
    const request = lnrpc.ChannelAcceptRequest.decode(data);
    const peer = Buffer.from(request.nodePubkey).toString("hex");
    const legacy =
      request.commitmentType === lnrpc.CommitmentType.LEGACY ||
      request.commitmentType === lnrpc.CommitmentType.STATIC_REMOTE_KEY ||
      request.commitmentType === lnrpc.CommitmentType.UNKNOWN_COMMITMENT_TYPE;
    const reject = rejectedPeers.has(peer) || legacy || request.wantsZeroConf;
    stream.write(
      lnrpc.ChannelAcceptResponse.encode({
        accept: !reject,
        pendingChanId: request.pendingChanId,
        error: reject ? "Channel rejected by the regtest wallet" : "",
      }).finish(),
    );
  });
  stream.on("error", (error: any) => {
    if (error?.code !== 1) {
      console.error("Channel acceptor stream error", error);
    }
  });
  return {
    rejectFrom: (pubkey: string) => rejectedPeers.add(pubkey),
    acceptFrom: (pubkey: string) => rejectedPeers.delete(pubkey),
    stop: () => stream.cancel(),
  };
}

const COMPOSE_FILE = path.join(__dirname, "docker-compose.yml");

/** Mines blocks on the regtest bitcoind. */
export function mine(blocks: number) {
  const cli = (args: string[]) => {
    const result = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        COMPOSE_FILE,
        "-p",
        "dunder-regtest",
        "exec",
        "-T",
        "bitcoind",
        "bitcoin-cli",
        "-regtest",
        "-rpcuser=dunder",
        "-rpcpassword=dunder",
        "-rpcwallet=miner",
        ...args,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`bitcoin-cli ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  cli(["generatetoaddress", String(blocks), cli(["getnewaddress"])]);
}

export async function waitFor<T>(
  description: string,
  check: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs = 60_000,
): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`);
}
