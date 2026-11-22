import { Client } from "@grpc/grpc-js";
import Long from "long";
import { Stream } from "stream";
import { DuplexMock, BufferWritableMock } from "stream-mock";

import { lnrpc } from "../../src/proto";
import { stringToUint8Array } from "../../src/utils/common";

export const __MOCK_BLOCK_HEIGHT = 800_000;

export async function getInfo(lightning: Client) {
  const getInfoResponse = lnrpc.GetInfoResponse.create({
    identityPubkey: "abc",
    blockHeight: __MOCK_BLOCK_HEIGHT,
  });
  return getInfoResponse;
}

export async function estimateFee(lightning: Client, amount: Long, targetConf: number) {
  const estimateFeeResponse = lnrpc.EstimateFeeResponse.create({
    feeSat: Long.fromValue(10),
    feerateSatPerByte: Long.fromValue(100),
  });
  return estimateFeeResponse;
}

let verifyMessageValidSig = true;
export const __verifyMessageSetValidSig = (valid: boolean) => (verifyMessageValidSig = valid);
export async function verifyMessage(lightning: Client, message: string, signature: string) {
  const verifyMessageResponse = lnrpc.VerifyMessageResponse.create({
    pubkey: verifyMessageValidSig ? "abcdef12345" : "notvalidsig",
  });
  return verifyMessageResponse;
}

export async function listPeers(lightning: Client) {
  const listPeersReponse = lnrpc.ListPeersResponse.create({
    peers: [
      {
        pubKey: "abcdef12345",
      },
    ],
  });
  return listPeersReponse;
}

let listChannelsResponse = lnrpc.ListChannelsResponse.create({ channels: [] });
let listChannelsError: Error | null = null;
export const __listChannels = jest.fn(async () => {
  if (listChannelsError) {
    throw listChannelsError;
  }
  return listChannelsResponse;
});
export const __setListChannelsResponse = (response: lnrpc.IListChannelsResponse) => {
  listChannelsError = null;
  listChannelsResponse = lnrpc.ListChannelsResponse.create(response);
};
export const __setListChannelsError = (error: Error | null) => {
  listChannelsError = error;
};
export async function listChannels(lightning: Client) {
  return __listChannels();
}
// Separate, so a test can make the shared list stale.
export const __listChannelsRecent = jest.fn((lightning: Client) => listChannels(lightning));
export const listChannelsRecent = (lightning: Client) => __listChannelsRecent(lightning);

let pendingChannelsResponse = lnrpc.PendingChannelsResponse.create({
  pendingOpenChannels: [],
});
export const __pendingChannels = jest.fn(async () => pendingChannelsResponse);
export const __setPendingChannelsResponse = (response: lnrpc.IPendingChannelsResponse) => {
  pendingChannelsResponse = lnrpc.PendingChannelsResponse.create(response);
};
export async function pendingChannels(lightning: Client) {
  return __pendingChannels();
}

export const forceCloseChannel = jest.fn(async (lightning: Client, channelPoint: string) =>
  lnrpc.CloseStatusUpdate.create({}),
);

export const openChannelSync = jest.fn(() => {
  const openChannelSyncResponse = lnrpc.ChannelPoint.create({
    fundingTxidBytes: stringToUint8Array("abcdef"),
    outputIndex: 0,
  });
  return openChannelSyncResponse;
});

export const __htlcInterceptorStream = new DuplexMock();
export function htlcInterceptor(router: Client) {
  return __htlcInterceptorStream;
}

export const __subscribeHtlcEventsStream = new BufferWritableMock();
export function subscribeHtlcEvents(router: Client) {
  return __subscribeHtlcEventsStream;
}

export function subscribeChannelEvents(lightning: Client) {
  return new Stream();
}

export const checkPeerConnected = jest.fn(() => {
  return true;
});
// Goes through checkPeerConnected, so tests control both with one mock.
export const checkPeerConnectedRecent = (lightning: Client, pubkey: string) =>
  (checkPeerConnected as jest.Mock)(lightning, pubkey);

export function subscribePeerEvents(lightning: Client) {
  return new Stream();
}

export const walletBalance = jest.fn(async () =>
  lnrpc.WalletBalanceResponse.create({
    totalBalance: Long.fromValue(100_000_000),
    confirmedBalance: Long.fromValue(100_000_000),
  }),
);

export const closedChannels = jest.fn(async () =>
  lnrpc.ClosedChannelsResponse.create({ channels: [] }),
);

/** Default: lnd has no final resolution stored (gRPC NOT_FOUND). */
export const lookupHtlcResolution = jest.fn(async (): Promise<lnrpc.LookupHtlcResolutionResponse> => {
  const error: any = new Error("5 NOT_FOUND: htlc unknown");
  error.code = 5;
  throw error;
});
