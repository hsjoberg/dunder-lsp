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

type HtlcInterceptorStream = ClientDuplexStream<any, any>;
type HtlcInterceptorStreamFactory = () => HtlcInterceptorStream;

type HtlcInterceptorCoordinatorOptions = {
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
};

export type StreamResetListener = () => void;

export const handled = (): HtlcHandlerResult => ({ status: "HANDLED" });
export const noDecision = (): HtlcHandlerResult => ({ status: "NO_DECISION" });

export class HtlcInterceptorCoordinator {
  private readonly streamFactory: HtlcInterceptorStreamFactory;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private stream: HtlcInterceptorStream | null = null;
  private readonly attachedStreams = new WeakSet<HtlcInterceptorStream>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private started = false;
  private stopped = false;
  private readonly resetListeners = new Set<StreamResetListener>();

  constructor(
    streamOrFactory: HtlcInterceptorStream | HtlcInterceptorStreamFactory,
    private readonly handlers: HtlcHandler[] = [],
    options: HtlcInterceptorCoordinatorOptions = {},
  ) {
    if (typeof streamOrFactory === "function") {
      this.streamFactory = streamOrFactory;
    } else {
      this.stream = streamOrFactory;
      this.streamFactory = () => streamOrFactory;
    }

    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
  }

  registerHandler(handler: HtlcHandler) {
    this.handlers.push(handler);
    if (this.started && this.stopped) {
      this.stopped = false;
      this.connect();
    }

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

      if (this.started && this.handlers.length === 0) {
        this.stop();
      }
    };
  }

  /**
   * Called whenever the current interceptor stream goes away. Responses written
   * to that stream are discarded: lnd either released the HTLCs it held (the
   * default `requireinterceptor=false`) or replays them on the next stream
   * (`requireinterceptor=true`). Handlers that keep HTLCs in memory must drop
   * them here.
   */
  onStreamReset(listener: StreamResetListener) {
    this.resetListeners.add(listener);
    return () => {
      this.resetListeners.delete(listener);
    };
  }

  private notifyStreamReset() {
    for (const listener of this.resetListeners) {
      try {
        listener();
      } catch (error) {
        console.error("HTLC interceptor reset listener failed", error);
      }
    }
  }

  setHandlers(handlers: HtlcHandler[]) {
    this.handlers.splice(0, this.handlers.length, ...handlers);
  }

  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.closeStream();
  }

  private connect() {
    if (this.stopped) {
      return;
    }

    const stream = this.streamFactory();
    this.stream = stream;

    if (this.attachedStreams.has(stream)) {
      return;
    }
    this.attachedStreams.add(stream);

    stream.on("data", (data) => {
      this.reconnectAttempts = 0;
      const request = routerrpc.ForwardHtlcInterceptRequest.decode(data);
      this.handle(request, stream).catch((error) => {
        console.error("Unexpected HTLC interceptor error", error);
      });
    });

    stream.on("error", (error) => {
      console.error("HTLC interceptor stream error", error);
      this.scheduleReconnect(stream);
    });

    stream.on("end", () => {
      console.error("HTLC interceptor stream ended");
      this.scheduleReconnect(stream);
    });

    stream.on("close", () => {
      console.error("HTLC interceptor stream closed");
      this.scheduleReconnect(stream);
    });
  }

  private scheduleReconnect(stream: HtlcInterceptorStream) {
    if (this.stopped || this.reconnectTimer || this.stream !== stream) {
      return;
    }

    this.retireStream(stream);

    const delayMs = Math.min(
      this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempts += 1;

    console.error(`Reconnecting HTLC interceptor stream in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private retireStream(stream: HtlcInterceptorStream) {
    if (this.stream === stream) {
      this.stream = null;
    }

    stream.cancel?.();
    this.notifyStreamReset();
  }

  private closeStream() {
    if (!this.stream) {
      return;
    }

    const stream = this.stream;
    this.stream = null;
    stream.removeAllListeners?.("data");
    stream.removeAllListeners?.("error");
    stream.removeAllListeners?.("end");
    stream.removeAllListeners?.("close");
    this.attachedStreams.delete(stream);
    stream.cancel?.();
    this.notifyStreamReset();
  }

  async handle(
    request: routerrpc.ForwardHtlcInterceptRequest,
    responseStream: HtlcInterceptorStream | null = this.stream,
  ) {
    if (!responseStream) {
      console.error("Cannot respond to HTLC because interceptor stream is not connected");
      return;
    }

    const writer = new StreamHtlcResponseWriter(responseStream);

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

/**
 * The only failure codes lnd's interceptor accepts (routerrpc
 * forward_interceptor.go, lnd 0.16 to 0.19). Any other code makes lnd end the
 * interceptor stream. No code means TEMPORARY_CHANNEL_FAILURE.
 */
const LND_ACCEPTED_FAILURE_CODES = new Set<lnrpc.Failure.FailureCode>([
  lnrpc.Failure.FailureCode.TEMPORARY_CHANNEL_FAILURE,
  lnrpc.Failure.FailureCode.INVALID_ONION_HMAC,
  lnrpc.Failure.FailureCode.INVALID_ONION_KEY,
  lnrpc.Failure.FailureCode.INVALID_ONION_VERSION,
]);

/**
 * Answers one intercepted HTLC. lnd ends the whole interceptor stream when a
 * response fails, and answering a circuit that is no longer held is such a
 * failure. Each writer therefore sends at most one response.
 */
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
    if (this.didRespond) {
      console.error("Refusing to answer an intercepted HTLC twice", {
        action,
        chanId: incomingCircuitKey?.chanId?.toString(),
        htlcId: incomingCircuitKey?.htlcId?.toString(),
      });
      return;
    }
    this.didRespond = true;

    if (
      action === routerrpc.ResolveHoldForwardAction.FAIL &&
      failureCode !== undefined &&
      !LND_ACCEPTED_FAILURE_CODES.has(failureCode)
    ) {
      console.error("Replacing a failure code lnd's interceptor would reject", { failureCode });
      failureCode = undefined;
    }

    const response = routerrpc.ForwardHtlcInterceptResponse.encode({
      action,
      incomingCircuitKey,
      preimage,
      failureCode,
    }).finish();
    try {
      this.stream.write(response);
    } catch (error) {
      // The stream is gone. lnd releases or replays the HTLC.
      console.error("Could not answer intercepted HTLC", error);
    }
  }
}

let coordinator: HtlcInterceptorCoordinator | null = null;

export function startHtlcInterceptor(router: Client) {
  if (!coordinator) {
    coordinator = new HtlcInterceptorCoordinator(() => htlcInterceptor(router));
    coordinator.start();
  }

  return coordinator;
}
