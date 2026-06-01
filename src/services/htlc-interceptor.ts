import { Client, ClientDuplexStream } from "@grpc/grpc-js";
import { lnrpc, routerrpc } from "../proto";
import { htlcInterceptor } from "../utils/lnd-api";

export type HtlcHandlerResult =
  | { status: "HANDLED" }
  | { status: "NO_DECISION" };

export type HtlcResponseWriter = {
  readonly responded: boolean;
  respond(
    action: routerrpc.ResolveHoldForwardAction,
    incomingCircuitKey: routerrpc.ForwardHtlcInterceptRequest["incomingCircuitKey"],
    preimage?: Uint8Array,
    failureCode?: lnrpc.Failure.FailureCode,
  ): void;
};

export type HtlcHandler = (
  request: routerrpc.ForwardHtlcInterceptRequest,
  writer: HtlcResponseWriter,
) => Promise<HtlcHandlerResult> | HtlcHandlerResult;

export const handled = (): HtlcHandlerResult => ({ status: "HANDLED" });
export const noDecision = (): HtlcHandlerResult => ({ status: "NO_DECISION" });

export class HtlcInterceptorCoordinator {
  constructor(
    private readonly stream: ClientDuplexStream<any, any>,
    private readonly handlers: HtlcHandler[] = [],
  ) {}

  registerHandler(handler: HtlcHandler) {
    this.handlers.push(handler);
    let registered = true;

    return () => {
      if (!registered) {
        return;
      }

      registered = false;
      const index = this.handlers.indexOf(handler);
      if (index !== -1) {
        this.handlers.splice(index, 1);
      }
    };
  }

  setHandlers(handlers: HtlcHandler[]) {
    this.handlers.splice(0, this.handlers.length, ...handlers);
  }

  start() {
    this.stream.on("data", (data) => {
      const request = routerrpc.ForwardHtlcInterceptRequest.decode(data);
      this.handle(request).catch((error) => {
        console.error("Unexpected HTLC interceptor error", error);
      });
    });

    this.stream.on("error", (error) => {
      console.error("HTLC interceptor stream error", error);
    });
  }

  async handle(request: routerrpc.ForwardHtlcInterceptRequest) {
    const writer = new StreamHtlcResponseWriter(this.stream);

    for (const handler of this.handlers) {
      try {
        const result = await handler(request, writer);
        if (writer.responded) {
          return;
        }
        if (result.status === "HANDLED") {
          return;
        }
      } catch (error) {
        console.error("HTLC handler failed unexpectedly, resuming HTLC", error);
        if (!writer.responded) {
          writer.respond(
            routerrpc.ResolveHoldForwardAction.RESUME,
            request.incomingCircuitKey,
          );
        }
        return;
      }
    }

    if (!writer.responded) {
      writer.respond(
        routerrpc.ResolveHoldForwardAction.RESUME,
        request.incomingCircuitKey,
      );
    }
  }
}

class StreamHtlcResponseWriter implements HtlcResponseWriter {
  private didRespond = false;

  constructor(private readonly stream: ClientDuplexStream<any, any>) {}

  get responded() {
    return this.didRespond;
  }

  respond(
    action: routerrpc.ResolveHoldForwardAction,
    incomingCircuitKey: routerrpc.ForwardHtlcInterceptRequest["incomingCircuitKey"],
    preimage?: Uint8Array,
    failureCode?: lnrpc.Failure.FailureCode,
  ) {
    const response = routerrpc.ForwardHtlcInterceptResponse.encode({
      action,
      incomingCircuitKey,
      preimage,
      failureCode,
    }).finish();
    this.stream.write(response);
    this.didRespond = true;
  }
}

let coordinator: HtlcInterceptorCoordinator | null = null;

export function startHtlcInterceptor(router: Client) {
  if (!coordinator) {
    coordinator = new HtlcInterceptorCoordinator(htlcInterceptor(router));
    coordinator.start();
  }

  return coordinator;
}
