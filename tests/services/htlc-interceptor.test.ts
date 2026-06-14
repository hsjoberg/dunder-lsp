import Long from "long";
import { EventEmitter } from "events";

import { routerrpc } from "../../src/proto";
import {
  handled,
  HtlcHandler,
  HtlcInterceptorCoordinator,
  noDecision,
} from "../../src/services/htlc-interceptor";

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
});
