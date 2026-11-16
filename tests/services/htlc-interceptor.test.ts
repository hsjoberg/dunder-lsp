import Long from "long";
import { EventEmitter } from "events";

import { lnrpc, routerrpc } from "../../src/proto";
import {
  createOnChainOfferCheck,
  handled,
  HtlcHandler,
  HtlcInterceptorCoordinator,
  noDecision,
} from "../../src/services/htlc-interceptor";
import { __listChannels, __setListChannelsResponse } from "../../mocks/utils/lnd-api";

function request(incomingChannelId: Long, outgoingChannelId: Long) {
  return routerrpc.ForwardHtlcInterceptRequest.create({
    incomingCircuitKey: routerrpc.CircuitKey.create({
      chanId: incomingChannelId,
      htlcId: Long.fromValue(1),
    }),
    outgoingRequestedChanId: outgoingChannelId,
  });
}

function stream(writes: routerrpc.ForwardHtlcInterceptResponse[]) {
  return {
    on: jest.fn(),
    write: jest.fn((data: Uint8Array) => {
      writes.push(routerrpc.ForwardHtlcInterceptResponse.decode(data));
      return true;
    }),
  } as any;
}

class ReconnectableStream extends EventEmitter {
  writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
  cancel = jest.fn();

  write(data: Uint8Array) {
    this.writes.push(routerrpc.ForwardHtlcInterceptResponse.decode(data));
    return true;
  }
}

function emitInterceptRequest(
  stream: ReconnectableStream,
  interceptRequest: routerrpc.ForwardHtlcInterceptRequest,
) {
  stream.emit("data", routerrpc.ForwardHtlcInterceptRequest.encode(interceptRequest).finish());
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("HtlcInterceptorCoordinator", () => {
  test("calls handlers in order", async () => {
    const calls: string[] = [];
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const coordinator = new HtlcInterceptorCoordinator(stream(writes), [
      () => {
        calls.push("first");
        return noDecision();
      },
      (request, writer) => {
        calls.push("second");
        writer.respond(routerrpc.ResolveHoldForwardAction.RESUME, request.incomingCircuitKey);
        return handled();
      },
    ]);

    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));

    expect(calls).toEqual(["first", "second"]);
    expect(writes[0].action).toBe(routerrpc.ResolveHoldForwardAction.RESUME);
  });

  test("stops after the first handled result", async () => {
    const calls: string[] = [];
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const coordinator = new HtlcInterceptorCoordinator(stream(writes), [
      (request, writer) => {
        calls.push("first");
        writer.respond(routerrpc.ResolveHoldForwardAction.FAIL, request.incomingCircuitKey);
        return handled();
      },
      () => {
        calls.push("second");
        return noDecision();
      },
    ]);

    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));

    expect(calls).toEqual(["first"]);
    expect(writes).toHaveLength(1);
    expect(writes[0].action).toBe(routerrpc.ResolveHoldForwardAction.FAIL);
  });

  test("resumes by default when every handler has no decision", async () => {
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const coordinator = new HtlcInterceptorCoordinator(stream(writes), [
      () => noDecision(),
      () => noDecision(),
    ]);

    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));

    expect(writes).toHaveLength(1);
    expect(writes[0].action).toBe(routerrpc.ResolveHoldForwardAction.RESUME);
  });

  test("resumes when a handler errors unexpectedly", async () => {
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const handlers: HtlcHandler[] = [
      () => {
        throw new Error("boom");
      },
    ];
    const coordinator = new HtlcInterceptorCoordinator(stream(writes), handlers);

    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));

    expect(writes).toHaveLength(1);
    expect(writes[0].action).toBe(routerrpc.ResolveHoldForwardAction.RESUME);
  });

  test("unregisters handlers", async () => {
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const coordinator = new HtlcInterceptorCoordinator(stream(writes));
    const handler = jest.fn((request, writer) => {
      writer.respond(routerrpc.ResolveHoldForwardAction.FAIL, request.incomingCircuitKey);
      return handled();
    });

    const unregister = coordinator.registerHandler(handler);
    unregister();

    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));

    expect(handler).not.toBeCalled();
    expect(writes[0].action).toBe(routerrpc.ResolveHoldForwardAction.RESUME);
  });

  test("reconnects after a stream error and keeps registered handlers", async () => {
    const streams: ReconnectableStream[] = [];
    const coordinator = new HtlcInterceptorCoordinator(
      () => {
        const reconnectableStream = new ReconnectableStream();
        streams.push(reconnectableStream);
        return reconnectableStream as any;
      },
      [
        (request, writer) => {
          writer.respond(routerrpc.ResolveHoldForwardAction.FAIL, request.incomingCircuitKey);
          return handled();
        },
      ],
      {
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 1,
      },
    );

    coordinator.start();
    expect(streams).toHaveLength(1);

    streams[0].emit("error", new Error("stream unavailable"));
    await wait(5);

    expect(streams).toHaveLength(2);
    expect(streams[0].cancel).toBeCalledTimes(1);

    emitInterceptRequest(streams[1], request(Long.fromValue(1), Long.fromValue(2)));
    await wait(0);

    expect(streams[1].writes).toHaveLength(1);
    expect(streams[1].writes[0].action).toBe(routerrpc.ResolveHoldForwardAction.FAIL);

    coordinator.stop();
  });

  test("does not schedule duplicate reconnects for the same dead stream", async () => {
    const streams: ReconnectableStream[] = [];
    const coordinator = new HtlcInterceptorCoordinator(
      () => {
        const reconnectableStream = new ReconnectableStream();
        streams.push(reconnectableStream);
        return reconnectableStream as any;
      },
      [],
      {
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 1,
      },
    );

    coordinator.start();
    streams[0].emit("error", new Error("stream unavailable"));
    streams[0].emit("close");
    streams[0].emit("end");
    await wait(5);

    expect(streams).toHaveLength(2);

    coordinator.stop();
  });
  test("answers an HTLC at most once", async () => {
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const answerTwice: HtlcHandler = (htlc, writer) => {
      writer.respond(routerrpc.ResolveHoldForwardAction.SETTLE, htlc.incomingCircuitKey);
      writer.respond(routerrpc.ResolveHoldForwardAction.FAIL, htlc.incomingCircuitKey);
      return handled();
    };
    const coordinator = new HtlcInterceptorCoordinator(stream(writes), [answerTwice]);

    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));

    expect(writes.map((write) => write.action)).toEqual([
      routerrpc.ResolveHoldForwardAction.SETTLE,
    ]);
  });

  test("tells listeners when the stream is replaced", async () => {
    jest.useFakeTimers();
    try {
      const streams: ReconnectableStream[] = [];
      const coordinator = new HtlcInterceptorCoordinator(
        () => {
          const next = new ReconnectableStream();
          streams.push(next);
          return next as any;
        },
        [() => noDecision()],
      );
      const onReset = jest.fn();
      coordinator.onStreamReset(onReset);
      coordinator.start();

      streams[0].emit("error", new Error("lnd restarted"));

      expect(onReset).toBeCalledTimes(1);
      coordinator.stop();
    } finally {
      jest.useRealTimers();
    }
  });
  test("never sends a failure code lnd's interceptor rejects", async () => {
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const failUnsupported: HtlcHandler = (htlc, writer) => {
      writer.respond(
        routerrpc.ResolveHoldForwardAction.FAIL,
        htlc.incomingCircuitKey,
        undefined,
        lnrpc.Failure.FailureCode.INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS,
      );
      return handled();
    };
    const coordinator = new HtlcInterceptorCoordinator(stream(writes), [failUnsupported]);

    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));

    expect(writes[0].action).toBe(routerrpc.ResolveHoldForwardAction.FAIL);
    expect(writes[0].failureCode).toBe(0);
  });

  describe("an HTLC offered again after its channel went on-chain", () => {
    const SETTLE = routerrpc.ResolveHoldForwardAction.SETTLE;
    const onChain = () => true;

    test("is left unanswered by default, on FAIL and on handler errors", async () => {
      for (const handler of [
        () => noDecision(),
        ((htlc, writer) => {
          writer.respond(routerrpc.ResolveHoldForwardAction.FAIL, htlc.incomingCircuitKey);
          return handled();
        }) as HtlcHandler,
        () => {
          throw new Error("boom");
        },
      ]) {
        const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
        const coordinator = new HtlcInterceptorCoordinator(stream(writes), [handler], {
          isOnChainOffer: onChain,
        });
        await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));
        // lnd accepts only SETTLE here and would end the stream on anything else.
        expect(writes).toEqual([]);
      }
    });

    test("can still be settled, so lnd gets the preimage for its on-chain claim", async () => {
      const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
      let sawOnChain: boolean | undefined;
      const coordinator = new HtlcInterceptorCoordinator(
        stream(writes),
        [
          (htlc, writer) => {
            sawOnChain = writer.onChain;
            writer.respond(SETTLE, htlc.incomingCircuitKey, new Uint8Array(32));
            return handled();
          },
        ],
        { isOnChainOffer: onChain },
      );
      await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));
      expect(sawOnChain).toBe(true);
      expect(writes.map((write) => write.action)).toEqual([SETTLE]);
    });
  });

  test("recognises an on-chain offer by lnd's auto-fail height and a channel no longer open", async () => {
    __setListChannelsResponse({ channels: [{ chanId: Long.fromValue(5, true) }] });
    __listChannels.mockClear();
    let time = 0;
    const isOnChain = createOnChainOfferCheck({} as any, () => time);
    const offer = (chanId: number, autoFailHeight: number) =>
      routerrpc.ForwardHtlcInterceptRequest.create({
        incomingCircuitKey: { chanId: Long.fromValue(chanId, true), htlcId: Long.fromValue(1) },
        incomingExpiry: 500,
        autoFailHeight,
      });

    // Ordinary offers (auto-fail 13 blocks before expiry) cost no lnd call.
    expect(await isOnChain(offer(9, 487))).toBe(false);
    expect(__listChannels).not.toHaveBeenCalled();

    expect(await isOnChain(offer(5, 500))).toBe(false); // Channel still open.
    expect(await isOnChain(offer(9, 500))).toBe(true); // Channel gone.
    // The open channels are reloaded at most once a second.
    expect(__listChannels).toHaveBeenCalledTimes(1);

    // Channel 5 closes: seen once the list is reloaded, even though it was
    // open in the previous list.
    __setListChannelsResponse({ channels: [] });
    time += 1_000;
    expect(await isOnChain(offer(5, 500))).toBe(true);
    expect(__listChannels).toHaveBeenCalledTimes(2);
    __setListChannelsResponse({ channels: [] });
  });

  test("resets the reconnect backoff only after a stream stayed up, not on data", async () => {
    jest.useFakeTimers();
    const delays: number[] = [];
    const errorSpy = jest.spyOn(console, "error").mockImplementation((message: unknown) => {
      const match = /in (\d+)ms/.exec(String(message));
      if (match) delays.push(Number(match[1]));
    });
    try {
      const streams: ReconnectableStream[] = [];
      const coordinator = new HtlcInterceptorCoordinator(
        () => {
          const next = new ReconnectableStream();
          streams.push(next);
          return next as any;
        },
        [() => noDecision()],
        { reconnectDelayMs: 10, stableStreamMs: 1_000 },
      );
      coordinator.start();
      const dropAfterReplay = () => {
        const current = streams[streams.length - 1];
        emitInterceptRequest(current, request(Long.fromValue(1), Long.fromValue(2)));
        current.emit("error", new Error("lnd ended the stream"));
      };

      dropAfterReplay();
      jest.advanceTimersByTime(10);
      dropAfterReplay();
      jest.advanceTimersByTime(20);
      dropAfterReplay();
      jest.advanceTimersByTime(40);
      // This stream stays up long enough.
      jest.advanceTimersByTime(1_000);
      dropAfterReplay();

      expect(delays).toEqual([10, 20, 40, 10]);
      // Three drops within a minute are warned about.
      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).startsWith("HTLC interceptor stream dropped 3 times"),
        ),
      ).toBe(true);
      coordinator.stop();
    } finally {
      errorSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
