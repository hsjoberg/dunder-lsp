import { Client, ClientDuplexStream } from "@grpc/grpc-js";
import { lnrpc, routerrpc } from "../proto";
import { htlcInterceptor, listChannels } from "../utils/lnd-api";

export type HtlcHandlerResult =
  | { status: "HANDLED" }
  | { status: "NO_DECISION" };

export type HtlcResponseWriter = {
  readonly responded: boolean;
  /**
   * The HTLC's incoming channel has gone on-chain (force-closed). lnd offers
   * such an HTLC again so a preimage can be supplied, and accepts only SETTLE
   * for it; the writer leaves it unanswered for any other action.
   */
  readonly onChain?: boolean;
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
  /** A stream must stay up this long before the reconnect backoff resets. */
  stableStreamMs?: number;
  isOnChainOffer?: OnChainOfferCheck;
};

export type OnChainOfferCheck = (
  request: routerrpc.ForwardHtlcInterceptRequest,
) => Promise<boolean> | boolean;

export type StreamResetListener = () => void;

const DROP_WINDOW_MS = 60_000;
const DROPS_BEFORE_WARNING = 3;

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
  /** When the recent streams ended, to notice a stream lnd keeps ending. */
  private recentDrops: number[] = [];
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stableStreamMs: number;
  private readonly isOnChainOffer: OnChainOfferCheck;
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
    this.stableStreamMs = options.stableStreamMs ?? 30_000;
    this.isOnChainOffer = options.isOnChainOffer ?? (() => false);
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
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
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

    // Reset the backoff only once the stream has stayed up for a while. lnd
    // replays held HTLCs as soon as a stream opens, so a stream that lnd keeps
    // ending (for example over one bad answer) still gets data each time.
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
    }
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (this.stream === stream) {
        this.reconnectAttempts = 0;
      }
    }, this.stableStreamMs);
    this.stableTimer.unref?.();

    stream.on("data", (data) => {
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
    this.noteDrop();

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

  /**
   * Warns when lnd keeps ending the stream. Each drop releases (or replays)
   * the HTLCs Dunder holds, so a stream that drops again and again makes
   * on-demand payments fail. A cause can be an answer lnd rejects, repeated
   * on every reconnect.
   */
  private noteDrop() {
    const now = Date.now();
    this.recentDrops = this.recentDrops.filter((at) => now - at < DROP_WINDOW_MS);
    this.recentDrops.push(now);
    if (this.recentDrops.length >= DROPS_BEFORE_WARNING) {
      console.error(
        `HTLC interceptor stream dropped ${this.recentDrops.length} times in the last ` +
          `${DROP_WINDOW_MS / 1000} seconds; on-demand payments may be failing. Check lnd's ` +
          "log for the reason it ends the stream.",
      );
    }
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
    // Cancelling makes the stream emit a CANCELLED error; without a listener
    // that would be an unhandled error event.
    stream.on?.("error", () => undefined);
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

    let onChain = false;
    try {
      onChain = await this.isOnChainOffer(request);
    } catch (error) {
      console.error("Could not tell whether an intercepted HTLC is on-chain", error);
    }
    const writer = new StreamHtlcResponseWriter(responseStream, onChain);

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

  constructor(
    private readonly stream: ClientDuplexStream<any, any>,
    readonly onChain = false,
  ) {}

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

    if (this.onChain && action !== routerrpc.ResolveHoldForwardAction.SETTLE) {
      // lnd rejects anything but SETTLE for an on-chain HTLC and ends the
      // stream over it, and then offers the HTLC again on every new stream.
      // Unanswered, it stays with lnd until it expires.
      console.warn("Leaving an on-chain HTLC unanswered (lnd accepts only SETTLE for it)", {
        action: routerrpc.ResolveHoldForwardAction[action],
        chanId: incomingCircuitKey?.chanId?.toString(),
        htlcId: incomingCircuitKey?.htlcId?.toString(),
      });
      return;
    }

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

/**
 * Tells whether lnd offers an HTLC from a channel that went on-chain. Both
 * signs must agree: lnd (0.21) sets the auto-fail height to the incoming
 * expiry for such an offer, 13 blocks earlier for an ordinary one, and the
 * incoming channel is no longer open. The auto-fail check comes first, so
 * ordinary forwards need no lnd call; the open channels are then reloaded,
 * at most once a second.
 */
export function createOnChainOfferCheck(lightning: Client, now = Date.now): OnChainOfferCheck {
  let openChannelIds = new Set<string>();
  let loadedAt = -Infinity;
  let loading: Promise<void> | null = null;

  const load = async () => {
    const { channels } = await listChannels(lightning);
    const ids = new Set<string>();
    for (const channel of channels) {
      for (const id of [channel.chanId, channel.zeroConfConfirmedScid, ...(channel.aliasScids ?? [])]) {
        if (id && id.toString() !== "0") {
          ids.add(id.toString());
        }
      }
    }
    openChannelIds = ids;
    loadedAt = now();
  };

  return async (request) => {
    if (request.autoFailHeight <= 0 || request.autoFailHeight !== request.incomingExpiry) {
      return false;
    }
    const chanId = request.incomingCircuitKey?.chanId?.toString();
    if (!chanId) {
      return false;
    }
    // Reload even if the channel is cached as open: it may just have closed.
    // Only offers that match the auto-fail sign get here, so this is rare.
    if (now() - loadedAt >= 1_000) {
      loading ??= load().finally(() => {
        loading = null;
      });
      await loading;
    }
    return !openChannelIds.has(chanId);
  };
}

let coordinator: HtlcInterceptorCoordinator | null = null;

export function startHtlcInterceptor(router: Client, lightning: Client) {
  if (!coordinator) {
    coordinator = new HtlcInterceptorCoordinator(() => htlcInterceptor(router), [], {
      isOnChainOffer: createOnChainOfferCheck(lightning),
    });
    coordinator.start();
  }

  return coordinator;
}
