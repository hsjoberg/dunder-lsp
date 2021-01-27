import { FastifyPluginAsync } from "fastify";
import { Client } from "@grpc/grpc-js";
import { createHash } from "crypto";
import Long from "long";
import config from "config";

import { bytesToHexString, generateShortChannelId, hexToUint8Array } from "./utils/common.js";
import { lnrpc, routerrpc } from "./proto.js";
import {
  estimateFee,
  getInfo,
  htlcInterceptor,
  subscribeHtlcEvents,
  verifyMessage,
  openChannelSync,
  listPeers,
} from "./utils/lnd-api.js";
import db from "./db/db.js";
import {
  ChannelRequestStatus,
  createChannelRequest,
  getActiveChannelRequestsByPubkey,
  getChannelRequest,
  updateChannelRequest,
  updateChannelRequestByPubkey,
} from "./db/request.js";
import { MSAT } from "./utils/constants.js";

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
    console.log("verifyMessageResponse", verifyMessageResponse);
    console.log("registerRequest", registerRequest);
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
      expire: 0,
      expectedAmountSat: 0,
      actualSettledAmountSat: null,
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

    const response: ICheckStatusResponse = {
      state: channelRequests.length === 0 ? "NOT_REGISTERED" : channelRequests[0].status,
    };
    return response;
  });
} as FastifyPluginAsync<{ lightning: Client; router: Client }>;

const interceptHtlc = (lightning: Client, router: Client) => {
  const stream = htlcInterceptor(router);

  stream.on("data", async (data) => {
    const request = routerrpc.ForwardHtlcInterceptRequest.decode(data);

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
      if (channelRequest.status !== "REGISTERED") {
        console.error("Error: Got unexpected incoming HTLC");
        stream.write(
          routerrpc.ForwardHtlcInterceptResponse.encode({
            action: routerrpc.ResolveHoldForwardAction.FAIL,
            incomingCircuitKey: request.incomingCircuitKey,
          }).finish(),
        );
      } else {
        console.log("SETTLING INCOMING HTLC");
        if (
          bytesToHexString(request.paymentHash) !==
          createHash("sha256")
            .update(hexToUint8Array(channelRequest.preimage ?? ""))
            .digest("hex")
        ) {
          // TODO error handling
          console.error("Payment hash does not match");
          const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
            action: routerrpc.ResolveHoldForwardAction.FAIL,
            incomingCircuitKey: request.incomingCircuitKey,
          }).finish();
          stream.write(settleResponse);
          return;
        }

        let feeResult: lnrpc.EstimateFeeResponse | undefined;
        try {
          // Check whether we can still do this transaction
          feeResult = await estimateFee(lightning, request.outgoingAmountMsat.multiply(2), 1);
          if (
            request.outgoingAmountMsat
              .subtract(feeResult.feeSat.mul(MSAT))
              .lessThanOrEqual(20000 * MSAT)
          ) {
            throw new Error("Too high fee");
          }
        } catch (e) {
          // TODO error handling
          console.error("estimateFee failed", e);
          const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
            action: routerrpc.ResolveHoldForwardAction.FAIL,
            incomingCircuitKey: request.incomingCircuitKey,
          }).finish();
          stream.write(settleResponse);
          return;
        }
        const estimatedFeeMsat = feeResult.feeSat.mul(MSAT);

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

        // Signal to the HTLC subscription that we're waiting for a settlement
        updateChannelRequestByPubkey(db, {
          ...channelRequest,
          status: "WAITING_FOR_SETTLEMENT",
          actualSettledAmountSat: request.outgoingAmountMsat.subtract(estimatedFeeMsat).toNumber(),
        });

        // Send settlement action to bidi-stream
        const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
          action: routerrpc.ResolveHoldForwardAction.SETTLE,
          incomingCircuitKey: request.incomingCircuitKey,
          preimage: hexToUint8Array(channelRequest.preimage),
        }).finish();
        stream.write(settleResponse);
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
    const htlcEvent = routerrpc.HtlcEvent.decode(data);

    console.log("Incomming HTLC event");
    console.log("event", htlcEvent.event);
    console.log("eventType", htlcEvent.eventType);
    console.log(htlcEvent);

    if (!htlcEvent.settleEvent) {
      return;
    }

    const channelRequest = await getChannelRequest(db, htlcEvent.outgoingChannelId.toString());
    if (channelRequest) {
      if (channelRequest.status === "WAITING_FOR_SETTLEMENT") {
        if (channelRequest.actualSettledAmountSat === null) {
          console.error("ERROR: Got WAITING_FOR_SETTLEMENT when tmpOpenChannelAmountMsat is null");
          return;
        }

        const tmpOpenChannelAmountMsat = Long.fromValue(channelRequest.actualSettledAmountSat);
        try {
          // Check whether we can still do this transaction
          const result = await estimateFee(lightning, tmpOpenChannelAmountMsat.multiply(2), 1);
          // if (
          //   tmpOpenChannelAmountMsat
          //     .subtract(result.feeSat.mul(MSAT))
          //     .lessThanOrEqual(20000 * MSAT)
          // ) {
          //   throw new Error("Too high fee");
          // }
        } catch (e) {
          console.error("FATAL ERROR: got exception from estimateFee. Cannot open channel");
          return;
        }

        const result = await openChannelSync(
          lightning,
          channelRequest.pubkey,
          tmpOpenChannelAmountMsat.div(MSAT).mul(2),
          tmpOpenChannelAmountMsat.div(MSAT),
          true,
        );

        updateChannelRequest(db, {
          ...channelRequest,
          status: "DONE",
        });
      } else {
        console.error("Got Settle HTLC on unexpected user status: " + channelRequest.status);
      }
    }
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
