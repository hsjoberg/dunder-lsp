import { Client, Metadata } from "@grpc/grpc-js";
import Long from "long";

import { hexToUint8Array, stringToUint8Array } from "./common";
import { lnrpc, routerrpc } from "../proto";
import { grpcMakeUnaryRequest } from "./grpc";

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
  const estimateFeeRequest = lnrpc.EstimateFeeRequest.encode({
    AddrToAmount: {
      tb1qsl4hhqs8skzwknqhwjcyyyjepnwmq8tlcd32m3: amount,
      tb1qud0w7nh5qh7azyjj0phssxzxp9zqdk8g0czwv6: Long.fromValue(10000),
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

export async function openChannelSync(
  lightning: Client,
  pubkey: string,
  localFundingAmount: Long,
  pushSat: Long,
  privateChannel: boolean,
) {
  const openChannelSyncRequest = lnrpc.OpenChannelRequest.encode({
    nodePubkey: hexToUint8Array(pubkey),
    localFundingAmount,
    pushSat,
    targetConf: 1,
    private: privateChannel,
  }).finish();

  return await grpcMakeUnaryRequest<lnrpc.ChannelPoint>(
    lightning,
    "lnrpc.Lightning/OpenChannelSync",
    openChannelSyncRequest,
    lnrpc.ChannelPoint.decode,
  );
}
