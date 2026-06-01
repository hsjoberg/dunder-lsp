import Long from "long";

import { lnrpc, routerrpc } from "../../src/proto";
import { HtlcInterceptorCoordinator } from "../../src/services/htlc-interceptor";
import { createPublicPublicForwardBlocker } from "../../src/services/public-forward-firewall";

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

describe("public-public forward blocker", () => {
  const lndApi = require("../../src/utils/lnd-api");

  beforeEach(() => {
    lndApi.__listChannels.mockClear();
    lndApi.__setListChannelsError(null);
    lndApi.__setListChannelsResponse({ channels: [] });
  });

  async function runBlocker(channels: lnrpc.IChannel[], outgoingChannelId = Long.fromValue(2)) {
    lndApi.__setListChannelsResponse({ channels });
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const coordinator = new HtlcInterceptorCoordinator(stream(writes), [
      createPublicPublicForwardBlocker({} as any),
    ]);

    await coordinator.handle(request(Long.fromValue(1), outgoingChannelId));

    return writes[0];
  }

  test("flag disabled resumes public-public HTLCs by default", async () => {
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const coordinator = new HtlcInterceptorCoordinator(stream(writes), []);

    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));

    expect(writes[0].action).toBe(routerrpc.ResolveHoldForwardAction.RESUME);
  });

  test("flag enabled fails public-public HTLCs with temporary channel failure", async () => {
    const response = await runBlocker([
      { chanId: Long.fromValue(1), private: false },
      { chanId: Long.fromValue(2), private: false },
    ]);

    expect(response.action).toBe(routerrpc.ResolveHoldForwardAction.FAIL);
    expect(response.failureCode).toBe(lnrpc.Failure.FailureCode.TEMPORARY_CHANNEL_FAILURE);
  });

  test.each([
    ["public-private", false, true],
    ["private-public", true, false],
    ["private-private", true, true],
  ])("flag enabled resumes %s HTLCs", async (_name, incomingPrivate, outgoingPrivate) => {
    const response = await runBlocker([
      { chanId: Long.fromValue(1), private: incomingPrivate },
      { chanId: Long.fromValue(2), private: outgoingPrivate },
    ]);

    expect(response.action).toBe(routerrpc.ResolveHoldForwardAction.RESUME);
  });

  test("resumes when the outgoing channel id is zero", async () => {
    const response = await runBlocker([], Long.fromValue(0));

    expect(response.action).toBe(routerrpc.ResolveHoldForwardAction.RESUME);
    expect(lndApi.__listChannels).not.toBeCalled();
  });

  test("has no decision when a channel is missing from ListChannels", async () => {
    lndApi.__setListChannelsResponse({
      channels: [{ chanId: Long.fromValue(1), private: false }],
    });
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const blocker = createPublicPublicForwardBlocker({} as any);
    const result = await blocker(request(Long.fromValue(1), Long.fromValue(2)), {
      responded: false,
      respond: jest.fn((action, incomingCircuitKey, preimage, failureCode) => {
        writes.push(
          routerrpc.ForwardHtlcInterceptResponse.create({
            action,
            incomingCircuitKey,
            preimage,
            failureCode,
          }),
        );
      }),
    });

    expect(result.status).toBe("NO_DECISION");
    expect(writes).toHaveLength(0);
  });

  test("resumes when ListChannels fails", async () => {
    lndApi.__setListChannelsError(new Error("ListChannels failed"));
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const coordinator = new HtlcInterceptorCoordinator(stream(writes), [
      createPublicPublicForwardBlocker({} as any),
    ]);

    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));

    expect(writes[0].action).toBe(routerrpc.ResolveHoldForwardAction.RESUME);
  });

  test("caches channel visibility for 30 seconds", async () => {
    const blocker = createPublicPublicForwardBlocker({} as any);
    const writes: routerrpc.ForwardHtlcInterceptResponse[] = [];
    const coordinator = new HtlcInterceptorCoordinator(stream(writes), [blocker]);

    lndApi.__setListChannelsResponse({
      channels: [
        { chanId: Long.fromValue(1), private: true },
        { chanId: Long.fromValue(2), private: false },
      ],
    });

    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));
    await coordinator.handle(request(Long.fromValue(1), Long.fromValue(2)));

    expect(lndApi.__listChannels).toBeCalledTimes(1);
  });
});
