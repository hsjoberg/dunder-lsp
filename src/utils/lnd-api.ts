import { Client, Metadata } from "@grpc/grpc-js";
import { hexToUint8Array, stringToUint8Array } from "./common";
import { lnrpc, routerrpc } from "../proto";

import Long from "long";
import { Writer } from "protobufjs/minimal";
import { grpcMakeUnaryRequest } from "./grpc";

const feeEstimateAddressesByClient = new WeakMap<Client, [string, string]>();

export async function getInfo(lightning: Client) {
  const getInfoRequest = lnrpc.GetInfoRequest.encode({}).finish();
  const response = await grpcMakeUnaryRequest<lnrpc.GetInfoResponse>(
    lightning,
    "/lnrpc.Lightning/GetInfo",
    getInfoRequest,
    lnrpc.GetInfoResponse.decode,
  );
  return response;
}

export async function estimateFee(lightning: Client, amount: Long, targetConf: number) {
  const [feeEstimateAddress, changeEstimateAddress] = await getFeeEstimateAddresses(lightning);
  const estimateFeeRequest = lnrpc.EstimateFeeRequest.encode({
    AddrToAmount: {
      [feeEstimateAddress]: amount,
      [changeEstimateAddress]: Long.fromValue(10_000),
    },
    targetConf,
  }).finish();

  const response = await grpcMakeUnaryRequest<lnrpc.EstimateFeeResponse>(
    lightning,
    "/lnrpc.Lightning/EstimateFee",
    estimateFeeRequest,
    lnrpc.EstimateFeeResponse.decode,
  );
  return response;
}

export async function newAddress(lightning: Client) {
  const newAddressRequest = lnrpc.NewAddressRequest.encode({
    type: lnrpc.AddressType.WITNESS_PUBKEY_HASH,
  }).finish();
  const response = await grpcMakeUnaryRequest<lnrpc.NewAddressResponse>(
    lightning,
    "/lnrpc.Lightning/NewAddress",
    newAddressRequest,
    lnrpc.NewAddressResponse.decode,
  );
  return response;
}

async function getFeeEstimateAddresses(lightning: Client) {
  const cachedAddresses = feeEstimateAddressesByClient.get(lightning);
  if (cachedAddresses) {
    return cachedAddresses;
  }

  const firstAddress = await newAddress(lightning);
  const secondAddress = await newAddress(lightning);
  const addresses: [string, string] = [firstAddress.address, secondAddress.address];
  feeEstimateAddressesByClient.set(lightning, addresses);
  return addresses;
}

export async function verifyMessage(lightning: Client, message: string, signature: string) {
  const verifyMessageRequest = lnrpc.VerifyMessageRequest.encode({
    msg: stringToUint8Array(message),
    signature: signature,
  }).finish();
  const response = await grpcMakeUnaryRequest<lnrpc.VerifyMessageResponse>(
    lightning,
    "/lnrpc.Lightning/VerifyMessage",
    verifyMessageRequest,
    lnrpc.VerifyMessageResponse.decode,
  );
  return response;
}

export async function listPeers(lightning: Client) {
  // Only each peer's latest error: lnd keeps up to 10 per peer, and peers
  // choose their size.
  const listPeersRequest = lnrpc.ListPeersRequest.encode({ latestError: true }).finish();
  const response = await grpcMakeUnaryRequest<lnrpc.ListPeersResponse>(
    lightning,
    "/lnrpc.Lightning/ListPeers",
    listPeersRequest,
    lnrpc.ListPeersResponse.decode,
  );
  return response;
}

export async function listChannels(lightning: Client) {
  const listChannelsRequest = lnrpc.ListChannelsRequest.encode({
    peerAliasLookup: false,
  }).finish();
  const response = await grpcMakeUnaryRequest<lnrpc.ListChannelsResponse>(
    lightning,
    "/lnrpc.Lightning/ListChannels",
    listChannelsRequest,
    lnrpc.ListChannelsResponse.decode,
  );
  return response;
}

export async function openChannelSync(
  lightning: Client,
  pubkey: string,
  localFundingAmount: Long,
  pushSat: Long,
  privateChannel: boolean,
  zeroConf: boolean,
  taprootChannel: boolean,
  memo?: string,
) {
  const commitmentType = taprootChannel ? lnrpc.CommitmentType.SIMPLE_TAPROOT : lnrpc.CommitmentType.ANCHORS;

  const openChannelSyncRequest = lnrpc.OpenChannelRequest.encode({
    nodePubkey: hexToUint8Array(pubkey),
    localFundingAmount,
    pushSat,
    targetConf: 1,
    // Never fund a channel with unconfirmed UTXOs. An unconfirmed input can be
    // double-spent, and with zero-conf channels the pushed funds are usable
    // before the funding transaction confirms.
    minConfs: 1,
    private: privateChannel,
    spendUnconfirmed: false,
    zeroConf,
    commitmentType,
    memo,
  }).finish();

  // A peer that stalls the funding handshake would otherwise keep this call
  // (and the channel-open recovery loop waiting on it) hanging until lnd gives
  // up on the reservation. A timeout counts as an ambiguous failure: the
  // attempt is kept and matched to lnd's channels by its memo, so a channel
  // that lnd opens later is still recorded and never opened twice.
  return await grpcMakeUnaryRequest<lnrpc.ChannelPoint>(
    lightning,
    "/lnrpc.Lightning/OpenChannelSync",
    openChannelSyncRequest,
    lnrpc.ChannelPoint.decode,
    { deadline: Date.now() + OPEN_CHANNEL_TIMEOUT_MS },
  );
}

export const OPEN_CHANNEL_TIMEOUT_MS = 2 * 60 * 1000;

export function htlcInterceptor(router: Client) {
  return router.makeBidiStreamRequest(
    "/routerrpc.Router/HtlcInterceptor",
    (arg: any) => arg,
    (arg) => arg,
    new Metadata(),
    undefined,
  );
}

export function subscribeHtlcEvents(router: Client) {
  const request = routerrpc.SubscribeHtlcEventsRequest.encode({}).finish();
  return router.makeServerStreamRequest(
    "/routerrpc.Router/SubscribeHtlcEvents",
    (arg: any) => arg,
    (arg) => arg,
    request,
    new Metadata(),
    undefined,
  );
}

/**
 * Force-closes a channel: lnd broadcasts its latest commitment. Resolves once
 * lnd reports the close as pending (the transaction is published).
 */
/**
 * Gives up after `timeoutMs` if lnd hasn't confirmed the close by then, so a
 * caller never waits forever. lnd may still go ahead with the close.
 */
export function forceCloseChannel(lightning: Client, channelPoint: string, timeoutMs = 60_000) {
  const [fundingTxidStr, outputIndex] = channelPoint.split(":");
  const request = lnrpc.CloseChannelRequest.encode({
    channelPoint: { fundingTxidStr, outputIndex: Number(outputIndex) },
    force: true,
  }).finish();
  return new Promise<lnrpc.CloseStatusUpdate>((resolve, reject) => {
    const stream = lightning.makeServerStreamRequest(
      "/lnrpc.Lightning/CloseChannel",
      (arg: any) => arg,
      (arg) => arg,
      request,
      new Metadata(),
      { deadline: Date.now() + timeoutMs },
    );
    stream.on("data", (data: Uint8Array) => {
      stream.cancel();
      resolve(lnrpc.CloseStatusUpdate.decode(data));
    });
    stream.on("error", (error: any) => {
      // CANCELLED is our own cancel() after the first update.
      if (error?.code !== 1) {
        reject(error);
      }
    });
    stream.on("end", () => {
      // Without an update first: a no-op once already resolved.
      reject(new Error("lnd ended the CloseChannel stream without an update"));
    });
  });
}

/**
 * walletrpc.WalletKit/BumpForceCloseFee: lnd spends the anchor of the channel's
 * unconfirmed force-close transaction to get it confirmed within
 * `deadlineDelta` blocks, paying at most `budgetSat` in fees (all of it only if
 * the deadline is reached). Anchor and taproot channels only.
 *
 * walletrpc isn't in Dunder's generated protos, so the request is encoded here
 * (lnd v0.21 walletkit.proto, BumpForceCloseFeeRequest): chan_point = 1,
 * deadline_delta = 2, immediate = 4, budget = 5.
 */
export async function bumpForceCloseFee(
  lightning: Client,
  channelPoint: string,
  deadlineDelta: number,
  budgetSat: number,
) {
  const [fundingTxidStr, outputIndex] = channelPoint.split(":");
  const writer = Writer.create();
  lnrpc.ChannelPoint.encode(
    { fundingTxidStr, outputIndex: Number(outputIndex) },
    writer.uint32((1 << 3) | 2).fork(),
  ).ldelim();
  writer.uint32((2 << 3) | 0).uint32(deadlineDelta);
  writer.uint32((4 << 3) | 0).bool(true);
  writer.uint32((5 << 3) | 0).uint64(budgetSat);
  // A deadline, so a stuck call can't stall the deadline guard that runs it.
  await grpcMakeUnaryRequest(
    lightning,
    "/walletrpc.WalletKit/BumpForceCloseFee",
    writer.finish(),
    undefined,
    { deadline: Date.now() + BUMP_FORCE_CLOSE_FEE_TIMEOUT_MS },
  );
}

export const BUMP_FORCE_CLOSE_FEE_TIMEOUT_MS = 30_000;

export function subscribeChannelEvents(lightning: Client) {
  const request = lnrpc.ChannelEventSubscription.encode({}).finish();
  return lightning.makeServerStreamRequest(
    "/lnrpc.Lightning/SubscribeChannelEvents",
    (arg: any) => arg,
    (arg) => arg,
    request,
    new Metadata(),
    undefined,
  );
}

/**
 * Wraps a list call so callers within `ttlMs` share one answer. Every incoming
 * part checks the peer and channel lists, and anyone who has seen an invoice
 * can send parts, so these calls are shared rather than repeated per part.
 */
export function cachedFor<T>(ttlMs: number, load: (lightning: Client) => Promise<T>) {
  const cache = new WeakMap<Client, { expiresAt: number; value: Promise<T> }>();
  return (lightning: Client, now = Date.now()) => {
    const entry = cache.get(lightning);
    if (entry && entry.expiresAt > now) {
      return entry.value;
    }
    const value = load(lightning);
    cache.set(lightning, { expiresAt: now + ttlMs, value });
    value.catch(() => {
      if (cache.get(lightning)?.value === value) {
        cache.delete(lightning);
      }
    });
    return value;
  };
}

const LIST_CACHE_MS = 1000;
/** ListPeers, shared for up to a second. */
export const listPeersRecent = cachedFor(LIST_CACHE_MS, listPeers);
/** ListChannels, shared for up to a second. Not for checks that need the current state. */
export const listChannelsRecent = cachedFor(LIST_CACHE_MS, listChannels);

export async function checkPeerConnected(lightning: Client, pubkey: string) {
  return isPeerListed(await listPeers(lightning), pubkey);
}

/**
 * Like checkPeerConnected, on a peer list up to a second old. For incoming
 * parts only: a wallet that just connected and registers needs the current
 * list.
 */
export async function checkPeerConnectedRecent(lightning: Client, pubkey: string) {
  return isPeerListed(await listPeersRecent(lightning), pubkey);
}

function isPeerListed(listPeersResponse: lnrpc.ListPeersResponse, pubkey: string) {
  const seekPeer = listPeersResponse.peers.find((peer) => {
    return peer.pubKey === pubkey;
  });

  return !!seekPeer;
}

export async function pendingChannels(lightning: Client) {
  const getInfoRequest = lnrpc.PendingChannelsRequest.encode({}).finish();
  const response = await grpcMakeUnaryRequest<lnrpc.PendingChannelsResponse>(
    lightning,
    "/lnrpc.Lightning/PendingChannels",
    getInfoRequest,
    lnrpc.PendingChannelsResponse.decode,
  );
  return response;
}

export function subscribePeerEvents(lightning: Client) {
  const request = lnrpc.PeerEventSubscription.encode({}).finish();
  return lightning.makeServerStreamRequest(
    "/lnrpc.Lightning/SubscribePeerEvents",
    (arg: any) => arg,
    (arg) => arg,
    request,
    new Metadata(),
    undefined,
  );
}

export async function walletBalance(lightning: Client) {
  const request = lnrpc.WalletBalanceRequest.encode({}).finish();
  return await grpcMakeUnaryRequest<lnrpc.WalletBalanceResponse>(
    lightning,
    "/lnrpc.Lightning/WalletBalance",
    request,
    lnrpc.WalletBalanceResponse.decode,
  );
}

export async function closedChannels(lightning: Client) {
  const request = lnrpc.ClosedChannelsRequest.encode({}).finish();
  return await grpcMakeUnaryRequest<lnrpc.ClosedChannelsResponse>(
    lightning,
    "/lnrpc.Lightning/ClosedChannels",
    request,
    lnrpc.ClosedChannelsResponse.decode,
  );
}

/**
 * Looks up how lnd finally resolved an incoming HTLC. Requires lnd to run with
 * `store-final-htlc-resolutions=true`. lnd answers NOT_FOUND while the HTLC is
 * unresolved (or when resolutions aren't stored).
 */
export async function lookupHtlcResolution(lightning: Client, chanId: Long, htlcIndex: Long) {
  const request = lnrpc.LookupHtlcResolutionRequest.encode({
    chanId,
    htlcIndex,
  }).finish();
  return await grpcMakeUnaryRequest<lnrpc.LookupHtlcResolutionResponse>(
    lightning,
    "/lnrpc.Lightning/LookupHtlcResolution",
    request,
    lnrpc.LookupHtlcResolutionResponse.decode,
  );
}
