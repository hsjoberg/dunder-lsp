import { FastifyPluginAsync } from "fastify";
import { Client, ClientDuplexStream } from "@grpc/grpc-js";
import { createHash } from "crypto";
import Long from "long";
import config from "config";

import {
  bytesToHexString,
  generateShortChannelId,
  hexToUint8Array,
  sha256,
  timeout,
} from "../../utils/common.js";
import { lnrpc, routerrpc } from "../../proto.js";
import {
  estimateFee,
  getInfo,
  htlcInterceptor,
  subscribeHtlcEvents,
  verifyMessage,
  openChannelSync,
  listPeers,
} from "../../utils/lnd-api.js";
import db from "../../db/db.js";
import {
  ChannelRequestStatus,
  checkAllHtclSettlementsSettled,
  createChannelRequest,
  createHtlcSettlement,
  getActiveChannelRequestsByPubkey,
  getChannelRequest,
  getChannelRequestUnclaimedAmount,
  getHtlcSettlement,
  updateChannelRequest,
  updateChannelRequestByPubkey,
  updateHtlcSettlement,
} from "../../db/ondemand-channel.js";
import { MSAT } from "../../utils/constants.js";
import { differenceInSeconds } from "date-fns";
import { appendFile } from "fs";

export interface IErrorResponse {
  status: "ERROR";
  reason: string;
}

export interface IServiceStatusResponse {
  status: boolean;
  approxFeeSat: number;
  minimumPaymentSat: number;
  peer: string;
}

export interface IRegisterRequest {
  pubkey: string;
  signature: string; // Message has to be REGISTER base64
  preimage: string;
  amount: number;
}

export interface IRegisterOkResponse {
  status: "OK";
  servicePubKey: string;
  fakeChannelId: string;
  cltvExpiryDelta: number;
  feeBaseMsat: number;
  feeProportionalMillionths: number;
}

export interface ICheckStatusRequest {
  pubkey: string;
  signature: string;
}

export interface ICheckStatusResponse {
  state: ChannelRequestStatus;
  unclaimedAmountSat: number;
}

export interface IRegisterErrorResponse extends IErrorResponse {}
export interface IUnknownRequestResponse extends IErrorResponse {}

const OnDemandChannel = async function (app, { lightning, router }) {
  const lndNode = config.get<string>("backendConfig.lndNode");
  // Start the HTLC interception
  //
  // interceptHtlc is used to intercept an incoming HTLC and either accept
  // or deny it whether to open a channel or not
  //
  // `subscribeHtlc` is used to check whether
  // the incoming payment was settled, if yes we can
  // open a channel to the requesting party
  interceptHtlc(lightning, router);
  subscribeHtlc(lightning, router);

  // Figure out the pubkey of our own node
  const servicePubKey = (await getInfo(lightning)).identityPubkey;

  app.get("/service-status", async () => {
    const estimateFeeResponse = await estimateFee(lightning, Long.fromValue(100000), 1);

    // Close down the service if fees are too high
    const status = estimateFeeResponse.feerateSatPerByte.greaterThanOrEqual(200);

    // The miminum payment we'll accept is fee * 5
    const minimumPaymentSat = estimateFeeResponse.feeSat.mul(5);

    const response: IServiceStatusResponse = {
      status,
      approxFeeSat: estimateFeeResponse.feeSat.toNumber(),
      minimumPaymentSat: minimumPaymentSat.toNumber(),
      peer: `${servicePubKey}@${lndNode}`,
    };
    return response;
  });

  app.post("/register", async (request, reply) => {
    const registerRequest = JSON.parse(request.body as string) as IRegisterRequest;

    // Verify that the message is valid
    const verifyMessageResponse = await verifyMessage(
      lightning,
      "REGISTER",
      registerRequest.signature,
    );
    if (registerRequest.pubkey !== verifyMessageResponse.pubkey) {
      reply.code(400);
      const error: IRegisterErrorResponse = {
        status: "ERROR",
        reason:
          "The Public key provided doesn't match with the public key extracted from the signature. " +
          "Either the signature is wrong or you have signed with the wrong wallet.",
      };
      console.log(`pubkey ${registerRequest.pubkey} !== ${verifyMessageResponse.pubkey}`);
      return error;
    }

    // Check if the requester is connected to our Lightning node
    if (!(await checkPeerConnected(lightning, registerRequest.pubkey))) {
      reply.code(400);
      const error: IRegisterErrorResponse = {
        status: "ERROR",
        reason: "Wallet is not connected to Dunder's Lightning node.",
      };
      return error;
    }

    try {
      const activeChannelRequests = await getActiveChannelRequestsByPubkey(
        db,
        registerRequest.pubkey,
      );
      if (activeChannelRequests.length > 0) {
        // Dunno
      }
    } catch (e) {
      console.error(e);
    }

    const channelId = Long.fromValue(await generateShortChannelId());
    await createChannelRequest(db, {
      channelId: channelId.toString(),
      pubkey: registerRequest.pubkey,
      preimage: registerRequest.preimage,
      status: "REGISTERED",
      expire: 600,
      expectedAmountSat: registerRequest.amount,
      channelPoint: null,
    });

    const response: IRegisterOkResponse = {
      status: "OK",
      servicePubKey,
      fakeChannelId: channelId.toString(10),
      cltvExpiryDelta: 40,
      feeBaseMsat: 1,
      feeProportionalMillionths: 1,
    };
    return response;
  });

  app.post("/check-status", async (request, reply) => {
    const checkStatusRequest = JSON.parse(request.body as string) as ICheckStatusRequest;

    const verifyMessageResponse = await verifyMessage(
      lightning,
      "CHECKSTATUS",
      checkStatusRequest.signature,
    );
    if (checkStatusRequest.pubkey !== verifyMessageResponse.pubkey) {
      reply.code(400);
      const error: IRegisterErrorResponse = {
        status: "ERROR",
        reason: "Public key mismatch",
      };
      return error;
    }
    const channelRequests = await getActiveChannelRequestsByPubkey(db, checkStatusRequest.pubkey);
    const unclaimed = await getChannelRequestUnclaimedAmount(db, checkStatusRequest.pubkey);

    const response: ICheckStatusResponse = {
      state: channelRequests.length === 0 ? "NOT_REGISTERED" : channelRequests[0].status,
      unclaimedAmountSat: unclaimed,
    };
    return response;
  });

  // app.post("/claim-unclaimed", async (request, reply) => {
  //   reply.code(400);
  //   return { status: "ERROR", reason: "Not implemeneted." };
  // });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

// If the payment is an MPP,
// BOLT#4 Basic MPP require us to accumulate all HTLCs and only settle all at once
// when the expected total amount is reached.
// Thus we store the HLTC write stream and all relevant info in memory.
// HtlcHodl uses channelId as key.
interface HtlcHodl {
  [key: string]: {
    stream: ClientDuplexStream<any, any>;
    pubkey: string;
    htlcId: Long;
    incomingCircuitKey: routerrpc.ICircuitKey;
    amountMsat: Long;
    settled: boolean;
  }[];
}
const interceptedHtlcHodl: HtlcHodl = {};

const interceptHtlc = (lightning: Client, router: Client) => {
  const stream = htlcInterceptor(router);

  stream.on("data", async (data) => {
    console.log("\nINTERCEPTING HTLC\n-----------");
    const request = routerrpc.ForwardHtlcInterceptRequest.decode(data);
    console.log("incomingAmountMsat", request.incomingAmountMsat.toString());
    console.log("outgoingAmountMsat", request.outgoingAmountMsat.toString());
    console.log("incomingCircuitKey.htlcId", request.incomingCircuitKey?.htlcId?.toString());

    const channelRequest = await getChannelRequest(db, request.outgoingRequestedChanId.toString());
    if (!channelRequest) {
      console.log("SKIPPING INCOMING HTLC");
      stream.write(
        routerrpc.ForwardHtlcInterceptResponse.encode({
          action: routerrpc.ResolveHoldForwardAction.RESUME,
          incomingCircuitKey: request.incomingCircuitKey,
        }).finish(),
      );
    } else {
      if (0 && channelRequest.status !== "REGISTERED") {
        console.error("Error: Got unexpected incoming HTLC");
        stream.write(
          routerrpc.ForwardHtlcInterceptResponse.encode({
            action: routerrpc.ResolveHoldForwardAction.FAIL,
            incomingCircuitKey: request.incomingCircuitKey,
          }).finish(),
        );
      } else {
        console.log("MARKING UP INCOMING HTLC FOR SETTLEMENT");
        const paymentHash = sha256(hexToUint8Array(channelRequest.preimage ?? ""));
        if (bytesToHexString(request.paymentHash) !== paymentHash) {
          // TODO error handling
          console.error("Payment hash does not match");
          const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
            action: routerrpc.ResolveHoldForwardAction.FAIL,
            incomingCircuitKey: request.incomingCircuitKey,
          }).finish();
          stream.write(settleResponse);
          return;
        }

        // let feeResult: lnrpc.EstimateFeeResponse | undefined;
        // try {
        //   // Check whether we can still do this transaction
        //   feeResult = await estimateFee(
        //     lightning,
        //     request.outgoingAmountMsat.div(MSAT).multiply(2),
        //     1,
        //   );
        //   if (
        //     request.outgoingAmountMsat
        //       .subtract(feeResult.feeSat.mul(MSAT))
        //       .lessThanOrEqual(20000 * MSAT)
        //   ) {
        //     throw new Error("Too high fee");
        //   }
        // } catch (e) {
        //   // TODO error handling
        //   console.error("estimateFee failed", e);
        //   const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
        //     action: routerrpc.ResolveHoldForwardAction.FAIL,
        //     incomingCircuitKey: request.incomingCircuitKey,
        //   }).finish();
        //   stream.write(settleResponse);
        //   return;
        // }
        // const estimatedFeeMsat = feeResult.feeSat.mul(MSAT);

        // Check if the requester is connected to our Lightning node
        if (!checkPeerConnected(lightning, channelRequest.pubkey)) {
          // TODO error handling
          console.error("Wallet node not connected");
          const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
            action: routerrpc.ResolveHoldForwardAction.FAIL,
            incomingCircuitKey: request.incomingCircuitKey,
          }).finish();
          stream.write(settleResponse);
          return;
        }

        const channelId = request.outgoingRequestedChanId.toString();
        let openChannelWhenSettled = false;
        if (!interceptedHtlcHodl[channelId]) {
          interceptedHtlcHodl[channelId] = [];
          openChannelWhenSettled = true;
        }

        interceptedHtlcHodl[channelId].push({
          amountMsat: request.outgoingAmountMsat,
          htlcId: request.incomingCircuitKey?.htlcId ?? Long.fromValue(0), // TODO
          incomingCircuitKey: request.incomingCircuitKey!,
          pubkey: channelRequest.pubkey,
          stream,
          settled: false,
        });

        // Check if the total amount matches up:
        const total = interceptedHtlcHodl[channelId].reduce((prev, { amountMsat }) => {
          return prev.add(amountMsat);
        }, Long.fromValue(0));

        console.log("total", total.div(MSAT).toString());
        console.log("expected", channelRequest.expectedAmountSat);

        if (total.equals(Long.fromValue(channelRequest.expectedAmountSat).mul(MSAT))) {
          console.log("Total adds up!");
          for (const hodl of interceptedHtlcHodl[channelId]) {
            console.log("Settling part HTLC", hodl.htlcId.toString());
            // Send settlement action to bidi-stream
            const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
              action: routerrpc.ResolveHoldForwardAction.SETTLE,
              incomingCircuitKey: hodl.incomingCircuitKey,
              preimage: hexToUint8Array(channelRequest.preimage),
            }).finish();
            stream.write(settleResponse);

            await createHtlcSettlement(db, {
              channelId: request.outgoingRequestedChanId.toString(),
              htlcId: hodl.htlcId.toNumber(),
              amountSat: hodl.amountMsat.div(MSAT).toNumber(),
              settled: 0,
            });
          }
        }

        // Wait for all the parts to settle:
        const start = new Date();
        if (openChannelWhenSettled) {
          while (true) {
            const result = await checkAllHtclSettlementsSettled(
              db,
              request.outgoingRequestedChanId.toString(),
            );
            if (!result) {
              // Time-out reached
              if (differenceInSeconds(new Date(), start) > 10) {
                console.warn("Timed out waiting for HTLC settements.");
                console.warn("Attempting to cancel any outstanding ones.");
                for (const hodl of interceptedHtlcHodl[channelId]) {
                  if (!hodl.settled) {
                    console.warn("Rejecting", hodl.htlcId.toString());
                    const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
                      action: routerrpc.ResolveHoldForwardAction.FAIL,
                      incomingCircuitKey: hodl.incomingCircuitKey,
                    }).finish();
                    hodl.stream.write(settleResponse);
                  }
                }
                delete interceptedHtlcHodl[channelId];
                return;
              }

              console.log("HTLCs not settled yet waiting ...");
              await timeout(1000);
            } else {
              const partTotal = interceptedHtlcHodl[channelId].reduce((prev, { amountMsat }) => {
                return prev.add(amountMsat);
              }, Long.fromValue(0));

              if (partTotal.div(MSAT).notEquals(channelRequest.expectedAmountSat)) {
                console.error(
                  "FATAL ERROR: Total part htlc amount mismatch with expected total amount",
                );
                break;
              }

              console.log("Opening channel");
              const result = await openChannelSync(
                lightning,
                channelRequest.pubkey,
                partTotal.div(MSAT).mul(2),
                partTotal.div(MSAT),
                true,
                true,
              );
              const txId = bytesToHexString(result.fundingTxidBytes.reverse());
              await updateChannelRequest(db, {
                ...channelRequest,
                status: "DONE",
                channelPoint: `${txId}:${result.outputIndex}`,
              });
              delete interceptedHtlcHodl[channelId];
              console.log("DONE");
              break;
            }
          }
        }
      }
    }
  });

  stream.on("error", (error) => {
    console.log("error");
    console.log(error);
  });
};

const subscribeHtlc = (lightning: Client, router: Client) => {
  const stream = subscribeHtlcEvents(router);

  stream.on("data", async (data) => {
    console.log("\nINCOMMING HTLC EVENT\n-----------");
    const htlcEvent = routerrpc.HtlcEvent.decode(data);
    console.log("event", htlcEvent.event);
    console.log("incomingHtlcId", htlcEvent.incomingHtlcId.toString());

    const outgoingChannelId = htlcEvent.outgoingChannelId;
    const incomingHtlcId = htlcEvent.incomingHtlcId;

    if (!htlcEvent.settleEvent) {
      return;
    }

    const hodl = interceptedHtlcHodl[outgoingChannelId.toString()]?.find(({ htlcId }) => {
      return incomingHtlcId.equals(htlcId);
    });
    if (!hodl) {
      console.log("Could not find part HTLC.", incomingHtlcId.toString());
      return;
    } else {
      hodl.settled = true;
    }

    const htlcSettlement = await getHtlcSettlement(
      db,
      outgoingChannelId.toString(),
      incomingHtlcId.toNumber(),
    );
    if (!htlcSettlement) {
      console.error("FATAL ERROR: Could not find htlcSettlement in database");
      return;
    }

    await updateHtlcSettlement(db, {
      ...htlcSettlement,
      settled: 1,
    });
  });
};

export default OnDemandChannel;

async function checkPeerConnected(lightning: Client, pubkey: string) {
  const listPeersResponse = await listPeers(lightning);
  const seekPeer = listPeersResponse.peers.find((peer) => {
    return peer.pubKey === pubkey;
  });

  return !!seekPeer;
}
