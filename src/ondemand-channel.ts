import { SocketStream, WebsocketHandler } from "fastify-websocket";
import { Client, Metadata } from "@grpc/grpc-js";
import { lnrpc, routerrpc } from "./proto";

import { generateShortChannelId, hexToUint8Array } from "./utils/common";
import { grpcMakeUnaryRequest } from "./utils/grpc";
import Long from "long";
import {
  estimateFee,
  getInfo,
  htlcInterceptor,
  subscribeHtlcEvents,
  verifyMessage,
  openChannelSync,
} from "./utils/lnd-api";

const LND_NODE = process.env.LND_NODE as string;
if (!LND_NODE) {
  console.error("Dunder has to be started with LND_NODE environment variable");
  process.exit(1);
}
const MSAT = 1000;

type Pubkey = string;
type ChannelId = Long;

export interface ISocketUser {
  pubkey: string | null;
  state: "NOT_REGISTERED" | "REGISTERED" | "WAITING_FOR_SETTLEMENT";
  socket: SocketStream | null;
  channelId: ChannelId | null;
  preimage: string | null; // hex
  tmpOpenChannelAmountMsat: Long | null;
  // TODO save what outgoing msat to expect?
}
const socketUsers: ISocketUser[] = [];

export type Request = "SERVICESTATUS" | "REGISTER" | "CHECKSTATUS" | "PAYMENT_SETTLED";

export interface IRequest {
  request: Request;
}

export interface IResponse {
  request: Request;
}

export interface IServiceStatusRequest extends IRequest {
  request: "SERVICESTATUS";
}

export interface IServiceStatusResponse {
  request: "SERVICESTATUS";
  status: boolean;
  approxFeeSat: number;
  peer: string;
}

export interface IRegisterRequest extends IRequest {
  request: "REGISTER";
  pubkey: string;
  signature: string; // Message has to be REGISTER base64
  preimage: string;
}

export interface IRegisterOkResponse extends IResponse {
  request: "REGISTER";
  status: "OK";
  servicePubKey: string;
  fakeChannelId: string;
  cltvExpiryDelta: number;
  feeBaseMsat: number;
  feeProportionalMillionths: number;
}

export interface IPaymentSettledResponse extends IResponse {
  request: "PAYMENT_SETTLED";
  preimage: string;
}

export interface IRegisterErrorResponse extends IRegisterRequest {
  request: "REGISTER";
  status: "ERROR";
  reason: string;
}

export interface ICheckStatusRequest extends IRequest {
  request: "CHECKSTATUS";
}

export interface IUnknownRequestResponse {
  status: "ERROR";
  reason: string;
}

const OnDemandChannel = function (lightning: Client, router: Client) {
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
  let servicePubKey = "";
  getInfo(lightning)
    .then((response) => {
      servicePubKey = response.identityPubkey;
    })
    .catch((error) => {
      console.error(
        "WARNING: Unable to get service public key (GetInfo request): " + error.message,
      );
    });

  // Return a Websocket Fastify handler
  // This function is called everytime a new websocket connection is established
  return function (connection) {
    console.log("WebSocket connection opened");

    socketUsers.push({
      pubkey: null,
      socket: connection,
      state: "NOT_REGISTERED",
      channelId: null,
      preimage: null,
      tmpOpenChannelAmountMsat: null,
    });

    connection.socket.on("message", async (data: unknown) => {
      const request = JSON.parse(data as string) as
        | IRegisterRequest
        | IServiceStatusRequest
        | ICheckStatusRequest;

      switch (request.request) {
        case "SERVICESTATUS": {
          const estimateFeeResponse = await estimateFee(lightning, Long.fromValue(100000), 1);

          // Close down the service if fees are too high
          let status = estimateFeeResponse.feerateSatPerByte.greaterThanOrEqual(200);

          const response: IServiceStatusResponse = {
            request: "SERVICESTATUS",
            status,
            approxFeeSat: estimateFeeResponse.feeSat.toNumber(),
            // minFundingSat:
            peer: `${servicePubKey}@${LND_NODE}`,
          };
          connection.socket.send(JSON.stringify(response));
          break;
        }
        case "REGISTER": {
          console.log("GOT REGISTER");

          // TODO verify message
          // const response = await verifyMessage(lightning, request.signature);
          // TODO ListPeers check for node

          const i = socketUsers.findIndex((socketUser) => socketUser.socket === connection);
          console.log(i);
          const channelId = Long.fromValue(await generateShortChannelId()); //Long.fromString("123456789012345");
          console.log(channelId.toString());
          socketUsers[i] = {
            ...socketUsers[i],
            channelId,
            preimage: request.preimage,
            pubkey: request.pubkey,
            state: "REGISTERED",
          };
          const registerResponse: IRegisterOkResponse = {
            request: "REGISTER",
            status: "OK",
            servicePubKey,
            fakeChannelId: channelId.toString(10),
            cltvExpiryDelta: 40,
            feeBaseMsat: 1,
            feeProportionalMillionths: 1,
          };
          connection.socket.send(JSON.stringify(registerResponse));
          break;
        }
        case "CHECKSTATUS":
          const i = socketUsers.findIndex((socketUser) => socketUser.socket === connection);
          connection.socket.send(
            JSON.stringify({
              request: "CHECKSTATUS",
              preimage: socketUsers[i].preimage,
              channelId: socketUsers[i].channelId?.toString(10) ?? null,
              pubkey: socketUsers[i].pubkey,
              status: socketUsers[i].state,
            }),
          );
          break;
        default:
          console.error("Got unknown request: " + (request as any).request);
          break;
      }
    });
    connection.socket.on("close", () => {
      // socketUsers.delete(connection);
      const i = socketUsers.findIndex((socketUser) => socketUser.socket === connection);
      if (i === -1) {
        console.warn("WARNING: Got close on unknown socket user");
      } else {
        // socketUsers[i].socket = null;
      }
      console.log("WebSocket connection closed");
    });
  } as WebsocketHandler;
};

const interceptHtlc = (lightning: Client, router: Client) => {
  const stream = htlcInterceptor(router);

  stream.on("data", async (data) => {
    const request = routerrpc.ForwardHtlcInterceptRequest.decode(data);

    const i = socketUsers.findIndex((socketUser) => {
      if (!socketUser.channelId) {
        return false;
      }
      return request.outgoingRequestedChanId.eq(socketUser.channelId);
    });
    if (i === -1) {
      console.log("SKIPPING INCOMING HTLC");
      stream.write(
        routerrpc.ForwardHtlcInterceptResponse.encode({
          action: routerrpc.ResolveHoldForwardAction.RESUME,
          incomingCircuitKey: request.incomingCircuitKey,
        }).finish(),
      );
    } else {
      if (socketUsers[i].state !== "REGISTERED") {
        console.error("Error: Got unexpected incoming HTLC");
        stream.write(
          routerrpc.ForwardHtlcInterceptResponse.encode({
            action: routerrpc.ResolveHoldForwardAction.FAIL,
            incomingCircuitKey: request.incomingCircuitKey,
          }).finish(),
        );
      } else {
        console.log("SETTLING INCOMING HTLC");
        try {
          // Check whether we can still do this transaction
          const result = await estimateFee(lightning, request.outgoingAmountMsat.multiply(2), 1);
          if (
            request.outgoingAmountMsat
              .subtract(result.feeSat.mul(MSAT))
              .lessThanOrEqual(20000 * MSAT)
          ) {
            throw new Error("Too high fee");
          }
        } catch (e) {
          console.error("estimateFee failed", e);
          const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
            action: routerrpc.ResolveHoldForwardAction.FAIL,
            incomingCircuitKey: request.incomingCircuitKey,
          }).finish();
          stream.write(settleResponse);
          return;
        }

        // Signal to the HTLC subscription that we're waiting for a settlement
        socketUsers[i].state = "WAITING_FOR_SETTLEMENT";
        socketUsers[i].tmpOpenChannelAmountMsat = request.outgoingAmountMsat;

        // Send settlement action to bidi-stream
        const settleResponse = routerrpc.ForwardHtlcInterceptResponse.encode({
          action: routerrpc.ResolveHoldForwardAction.SETTLE,
          incomingCircuitKey: request.incomingCircuitKey,
          preimage: hexToUint8Array(socketUsers[i].preimage!),
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

    // if (htlcEvent.eventType !== routerrpc.HtlcEvent.EventType.RECEIVE) {
    //   return;
    // }

    if (!htlcEvent.settleEvent) {
      return;
    }

    const i = socketUsers.findIndex((socketUser) => {
      if (!socketUser.channelId) {
        return false;
      }
      return htlcEvent.outgoingChannelId.eq(socketUser.channelId);
    });
    if (i !== -1) {
      if (socketUsers[i].state === "WAITING_FOR_SETTLEMENT") {
        const tmpOpenChannelAmountMsat = socketUsers[i].tmpOpenChannelAmountMsat;
        if (tmpOpenChannelAmountMsat === null) {
          console.error("ERROR: Got WAITING_FOR_SETTLEMENT when tmpOpenChannelAmountMsat is null");
          return;
        }

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
          socketUsers[i].pubkey!,
          tmpOpenChannelAmountMsat.div(MSAT).mul(2),
          tmpOpenChannelAmountMsat.div(MSAT),
        );

        socketUsers[i] = {
          pubkey: null,
          socket: socketUsers[i].socket,
          state: "NOT_REGISTERED",
          channelId: null,
          preimage: null,
          tmpOpenChannelAmountMsat: null,
        };
      } else {
        console.error("Got Settle HTLC on unexpected user state: " + socketUsers[i].state);
      }
    } else {
      console.error("Cannot find socketUser");
    }
  });
};

export default OnDemandChannel;
