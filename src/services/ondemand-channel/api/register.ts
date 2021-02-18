import { RouteHandlerMethod } from "fastify";
import { Client, ClientDuplexStream } from "@grpc/grpc-js";
import { differenceInSeconds, getUnixTime, formatISO } from "date-fns";
import Long from "long";
import { Database } from "sqlite";
import config from "config";

import { routerrpc } from "../../../proto";
import { MSAT } from "../../../utils/constants";
import {
  checkAllHtclSettlementsSettled,
  createChannelRequest,
  createHtlcSettlement,
  getChannelRequest,
  getHtlcSettlement,
  IChannelRequestDB,
  updateChannelRequest,
  updateHtlcSettlement,
} from "../../../db/ondemand-channel";
import {
  bytesToHexString,
  generateShortChannelId,
  hexToUint8Array,
  sha256,
  timeout,
} from "../../../utils/common";
import {
  htlcInterceptor,
  openChannelSync,
  subscribeHtlcEvents,
  verifyMessage,
  checkPeerConnected,
  estimateFee,
} from "../../../utils/lnd-api";
import { IErrorResponse } from "../index";

import { checkFeeTooHigh, getMaximumPaymentSat, getMinimumPaymentSat } from "./utils";

export interface IRegisterRequest {
  pubkey: string;
  signature: string; // Message has to be REGISTER base64
  preimage: string;
  amountSat: number;
}

export interface IRegisterOkResponse {
  status: "OK";
  servicePubkey: string;
  fakeChannelId: string; // TODO make these as an array of route hints instead
  cltvExpiryDelta: number;
  feeBaseMsat: number;
  feeProportionalMillionths: number;
}

export default function Register(
  db: Database,
  lightning: Client,
  router: Client,
  servicePubkey: string,
): RouteHandlerMethod {
  console.log(formatISO(new Date()));
  // Start the HTLC interception
  //
  // interceptHtlc is used to intercept an incoming HTLC and either accept
  // or deny it whether to open a channel or not.
  //
  // `subscribeHtlc` is used to check whether
  // the incoming payment was settled, if yes we can
  // open a channel to the requesting party.
  interceptHtlc(db, lightning, router);
  subscribeHtlc(db, lightning);

  return async (request, reply) => {
    const registerRequest = JSON.parse(request.body as string) as IRegisterRequest;

    // Verify that the message is valid
    const verifyMessageResponse = await verifyMessage(
      lightning,
      "REGISTER",
      registerRequest.signature,
    );
    if (registerRequest.pubkey !== verifyMessageResponse.pubkey) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason:
          "The Public key provided doesn't match with the public key extracted from the signature. " +
          "Either the signature is wrong or you have signed with the wrong wallet.",
      };
      return error;
    }

    // Check if onchain fee is too high.
    // Dunder will cease to operate once the fees reach a certain threshold.
    const estimateFeeResponse = await estimateFee(lightning, Long.fromValue(100000), 1);
    const feesTooHigh = checkFeeTooHigh(
      estimateFeeResponse.feerateSatPerByte,
      estimateFeeResponse.feeSat,
    );
    if (feesTooHigh) {
      reply.code(503);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: "Dunder is currently not available because Bitcoin onchain fees are too high.",
      };
      return error;
    }

    // The minimum payment we'll accept.
    // Configurable via the `minimumPaymentMultiplier`.
    // As the user will have to pay the on-chain transaction cost, we require the payment to be
    // received has to be higher than current on-chain tx fee times a multiplier.
    //
    // A channel opening can also not be lower than the default minimum requirement by lnd.
    const minimumPaymentSat = getMinimumPaymentSat(estimateFeeResponse.feeSat);
    if (registerRequest.amountSat < 1 || minimumPaymentSat - 10000 > registerRequest.amountSat) {
      // ^ TODO
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: `The requested invoice is below the minimum requirement of ${minimumPaymentSat.toString()} satoshi`,
      };
      return error;
    }

    // The maximum payment we'll accept
    // Configurable via the maximumPaymentSat config
    const maximumPaymentSat = getMaximumPaymentSat();
    if (registerRequest.amountSat > maximumPaymentSat) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: `The requested invoice is above the maximum limit of ${maximumPaymentSat} satoshi`,
      };
      return error;
    }

    // Check if the requester is connected to our Lightning node
    // If not we'll immediately fail.
    if (!(await checkPeerConnected(lightning, registerRequest.pubkey))) {
      reply.code(400);
      const error: IErrorResponse = {
        status: "ERROR",
        reason: "Wallet is not connected to Dunder's Lightning node.",
      };
      return error;
    }

    // Generate a channelId and register the channel request to the database.
    // We will use this datase entry later on to check incoming HTLCs.
    const channelId = Long.fromValue(await generateShortChannelId());
    await createChannelRequest(db, {
      channelId: channelId.toString(),
      pubkey: registerRequest.pubkey,
      preimage: registerRequest.preimage,
      status: "REGISTERED",
      start: getUnixTime(new Date()),
      expire: 600,
      expectedAmountSat: registerRequest.amountSat,
      channelPoint: null,
    });

    const response: IRegisterOkResponse = {
      status: "OK",
      servicePubkey,
      fakeChannelId: channelId.toString(10),
      cltvExpiryDelta: 40,
      feeBaseMsat: 1,
      feeProportionalMillionths: 1,
    };
    console.log("New request, channelId =", channelId.toString(10));
    return response;
  };
}

// BOLT#4 Basic MPP require us to accumulate all part HTLCs and only settle all at once
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

/**
 * interceptHtlc subscribes to lnd's `HtlcIntercept` bidi-stream  to be ablet to settle
 * incoming forwarding HTLCs.
 *
 * It does the following:
 * 1. Intercepts incoming HTLC's
 * 2. Checks if it's related to a channel request
 * 3. Adds it to an HTLC cache. In case it's an MPP payment we need to wait for all HTLCs before we settle
 * 4. Sends settlement action(s) to lnd once all HTLCs has been received
 * 5. Calls `openChannelWhenHtlcsSettled` that waits from settlement feedback from subscribeChannelEvents
 *
 */
const interceptHtlc = (db: Database, lightning: Client, router: Client) => {
  const htlcWaitMs = config.get<number>("htlcWaitMs");
  const stream = htlcInterceptor(router);

  stream.on("data", async (data) => {
    console.log("\nINTERCEPTING HTLC\n-----------");
    console.log(formatISO(new Date()));
    const request = routerrpc.ForwardHtlcInterceptRequest.decode(data);
    console.log("outgoingAmountMsat", request.outgoingAmountMsat.toString());
    console.log("outgoingRequestedChanId", request.outgoingRequestedChanId.toString());
    console.log("incomingCircuitKey.chanId", request.incomingCircuitKey?.chanId?.toString());
    console.log("incomingCircuitKey.htlcId", request.incomingCircuitKey?.htlcId?.toString());
    console.log("outgoingAmountMsat.request.outgoingExpiry", request.outgoingExpiry.toString());

    // Check if this HTLC outgoing channel Id is related to a channel request
    // If it's not we'll resume the normal HTLC forwarding
    const channelRequest = await getChannelRequest(db, request.outgoingRequestedChanId.toString());
    if (!channelRequest) {
      console.log("SKIPPING INCOMING HTLC");
      stream.write(
        routerrpc.ForwardHtlcInterceptResponse.encode({
          action: routerrpc.ResolveHoldForwardAction.RESUME,
          incomingCircuitKey: request.incomingCircuitKey,
        }).finish(),
      );
      return;
    }

    // If we found this HTLC already in the database, we'll fail this HTLC.
    // This is related to a bug in lnd where HTLCs are replayed.
    if (
      await getHtlcSettlement(
        db,
        request.outgoingRequestedChanId?.toString(),
        request.incomingCircuitKey?.htlcId?.toNumber() ?? 0,
      )
    ) {
      console.error("WARNING, already found settlement in database");
      const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
        action: routerrpc.ResolveHoldForwardAction.FAIL,
        incomingCircuitKey: request.incomingCircuitKey,
      }).finish();
      stream.write(settleResponse);
      return;
    }

    console.log("MARKING UP INCOMING HTLC FOR SETTLEMENT");

    // Check if the payment hash for the HTLC matches with the preimage that we got.
    // Fail if it does not.
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

    // Check if the requester is connected to our Lightning node.
    // If not, we'll fail this HTLC
    // TODO(hsjoberg): maybe this is too harsh
    if (!checkPeerConnected(lightning, channelRequest.pubkey)) {
      console.error("Wallet node not connected");
      const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
        action: routerrpc.ResolveHoldForwardAction.FAIL,
        incomingCircuitKey: request.incomingCircuitKey,
      }).finish();
      stream.write(settleResponse);
      return;
    }

    const channelId = request.outgoingRequestedChanId.toString();

    // If this is the first HTLC for this outgoing channel Id that we have encountered.
    // Create a new hodl cache and start the timeout.
    // Once all HTLCs have been registered and settled. `openChannelWhenHtlcsSettled` will open the
    // payment channel to the requester.
    if (!interceptedHtlcHodl[channelId]) {
      interceptedHtlcHodl[channelId] = [];
      // When the first HTLC for this payment is registed,
      // we wait until we match expected amount, then settle everything.
      openChannelWhenHtlcsSettled(db, lightning, channelRequest, htlcWaitMs);
    }

    // Add this HTLC to our hodl cache.
    // A reference to the bidi-stream is saved here. This is to be able to settle the HTLC later on
    // in another interceptHtlc event.
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

    // Once the total amount matches the expected amount.
    // We'll start the settling of HTLCs.
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

        // Create a settlement record in the database.
        // `settled` is set to 0 (false) here because we are waiting for `subscribeHtlc` to
        // acknowledge the settlement.
        await createHtlcSettlement(db, {
          channelId: request.outgoingRequestedChanId.toString(),
          htlcId: hodl.htlcId.toNumber(),
          amountSat: hodl.amountMsat.div(MSAT).toNumber(),
          settled: 0,
        });
      }
    }
  });

  // TODO(hsjoberg)
  stream.on("error", (error) => {
    console.log("error");
    console.log(error);
  });
};

/**
 * openChannelWhenHtlcsSettled waits for HTLCs to be marked as settled in the database.
 * It is started by `interceptHtlc` when all incoming HTLCs has been registered and request
 * to settle has been sent.
 *
 * If any HTLC within the time period (timeoutMs config). The opening of channel to requesting party
 * will fail. To be able to claim those HTLCs that were settled, a `claim` request has to be done.
 */
async function openChannelWhenHtlcsSettled(
  db: Database,
  lightning: Client,
  channelRequest: IChannelRequestDB,
  timeoutMs: number,
) {
  const channelId = channelRequest.channelId;
  const start = new Date();
  while (true) {
    const result = await checkAllHtclSettlementsSettled(db, channelId);
    if (!result) {
      // Once the timeout is reached, we'll send a fail action to all pending HTLCs.
      // If this happens, the requesting party has to do a `claim` request to claim coins
      // for any settled HTLC.
      if (differenceInSeconds(new Date(), start) > timeoutMs) {
        console.warn("Timed out waiting for HTLC settlements.");
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
      // Count that all part HTLCs matches up with the total expected amount
      const partTotal = interceptedHtlcHodl[channelId].reduce((prev, { amountMsat }) => {
        return prev.add(amountMsat);
      }, Long.fromValue(0));

      // Make sure all part HTLCs match up with the expected amount.
      // Fail it this isn't the case. This should never happen.
      if (partTotal.div(MSAT).notEquals(channelRequest.expectedAmountSat)) {
        console.error("FATAL ERROR: Total part HTLC amount mismatch with expected total amount");
        break;
      }

      console.log("Opening channel");
      try {
        // Attempt to open a channel with the requesting party
        const result = await openChannelSync(
          lightning,
          channelRequest.pubkey,
          partTotal.div(MSAT).mul(2),
          partTotal.div(MSAT),
          true,
          true,
        );
        const txId = bytesToHexString(result.fundingTxidBytes.reverse());

        // Once we've opened a channel, we mark the channel requset as completed
        // TODO(hsjoberg): mark HTLCs as claimed!!!
        await updateChannelRequest(db, {
          ...channelRequest,
          status: "DONE",
          channelPoint: `${txId}:${result.outputIndex}`,
        });
      } catch (error) {
        console.error("Could not open channel", error);
      }
      delete interceptedHtlcHodl[channelId];
      console.log("DONE");
      break;
    }
  }
}

/**
 * subscribeHtlc subscribes to lnd's subscribeHtlcEvents stream.
 * If the HTLC is settled and related to a channel request, it will update the database.
 * The database update is then read by `openChannelWhenHtlcsSettled`.
 */
const subscribeHtlc = (db: Database, router: Client) => {
  const stream = subscribeHtlcEvents(router);

  stream.on("data", async (data) => {
    console.log("\nINCOMING HTLC EVENT\n-----------");
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
      console.log("Could not find part HTLC", incomingHtlcId.toString());
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
