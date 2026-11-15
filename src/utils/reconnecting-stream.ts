type ServerStream = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  cancel?: () => void;
};

type ReconnectingStreamOptions = {
  name: string;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
};

/**
 * Keeps an lnd server stream (SubscribeHtlcEvents, SubscribePeerEvents, ...)
 * subscribed. Without an `error` listener a stream error is an unhandled
 * EventEmitter error and crashes the process, e.g. whenever lnd restarts.
 * Returns a function that stops the subscription.
 */
export function subscribeWithReconnect(
  factory: () => ServerStream,
  onData: (data: any) => Promise<void> | void,
  options: ReconnectingStreamOptions,
) {
  const baseDelayMs = options.reconnectDelayMs ?? 1_000;
  const maxDelayMs = options.maxReconnectDelayMs ?? 30_000;
  const attached = new WeakSet<object>();
  let current: ServerStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let stopped = false;

  const scheduleReconnect = (stream: ServerStream, reason: string, error?: unknown) => {
    if (stopped || timer || current !== stream) {
      return;
    }
    current = null;
    try {
      stream.cancel?.();
    } catch {
      // The stream is already gone.
    }

    const delayMs = Math.min(baseDelayMs * Math.pow(2, attempts), maxDelayMs);
    attempts += 1;
    console.error(`${options.name} stream ${reason}, reconnecting in ${delayMs}ms`, error ?? "");
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delayMs);
    timer.unref?.();
  };

  const connect = () => {
    if (stopped) {
      return;
    }
    let stream: ServerStream;
    try {
      stream = factory();
    } catch (error) {
      console.error(`Could not subscribe to ${options.name}`, error);
      const placeholder: ServerStream = { on: () => undefined };
      current = placeholder;
      scheduleReconnect(placeholder, "could not be opened", error);
      return;
    }
    current = stream;
    if (attached.has(stream)) {
      return;
    }
    attached.add(stream);

    stream.on("data", (data: any) => {
      attempts = 0;
      Promise.resolve()
        .then(() => onData(data))
        .catch((error) => {
          console.error(`Unexpected error while handling ${options.name} event`, error);
        });
    });
    stream.on("error", (error: unknown) => scheduleReconnect(stream, "failed", error));
    stream.on("end", () => scheduleReconnect(stream, "ended"));
    stream.on("close", () => scheduleReconnect(stream, "closed"));
  };

  connect();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const stream = current;
    current = null;
    try {
      stream?.cancel?.();
    } catch {
      // Ignore.
    }
  };
}
