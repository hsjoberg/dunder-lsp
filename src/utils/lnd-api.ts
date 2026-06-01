import { Client, Metadata } from "@grpc/grpc-js";
import { hexToUint8Array, stringToUint8Array } from "./common";
import { lnrpc, routerrpc } from "../proto";

import Long from "long";
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
    "lnrpc.Lightning/EstimateFee",
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
  const listPeersRequest = lnrpc.ListPeersRequest.encode({}).finish();
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
  spendUnconfirmed: boolean,
  zeroConf: boolean,
  taprootChannel: boolean,
) {
  const commitmentType = taprootChannel ? lnrpc.CommitmentType.SIMPLE_TAPROOT : lnrpc.CommitmentType.ANCHORS;

  const openChannelSyncRequest = lnrpc.OpenChannelRequest.encode({
    nodePubkey: hexToUint8Array(pubkey),
    localFundingAmount,
    pushSat,
    targetConf: 1,
    minConfs: spendUnconfirmed ? 0 : 1,
    private: privateChannel,
    spendUnconfirmed,
    zeroConf,
    commitmentType,
  }).finish();

  return await grpcMakeUnaryRequest<lnrpc.ChannelPoint>(
    lightning,
    "lnrpc.Lightning/OpenChannelSync",
    openChannelSyncRequest,
    lnrpc.ChannelPoint.decode,
  );
}

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

export function subscribeChannelEvents(lightning: Client) {
  const request = lnrpc.ChannelEventSubscription.encode({}).finish();
  return lightning.makeServerStreamRequest(
    "/routerrpc.Lightning/SubscribeChannelEvents",
    (arg: any) => arg,
    (arg) => arg,
    request,
    new Metadata(),
    undefined,
  );
}

export async function checkPeerConnected(lightning: Client, pubkey: string) {
  const listPeersResponse = await listPeers(lightning);
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
