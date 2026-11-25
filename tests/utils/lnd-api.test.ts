import Long from "long";

import * as grpc from "../../src/utils/grpc";
import { lnrpc } from "../../src/proto";

const actualLndApi = jest.requireActual("../../src/utils/lnd-api");

describe("openChannelSync", () => {
  test("never funds a channel with unconfirmed UTXOs", async () => {
    const makeUnaryRequest = jest
      .spyOn(grpc, "grpcMakeUnaryRequest")
      .mockResolvedValue(lnrpc.ChannelPoint.create({ fundingTxidStr: "txid", outputIndex: 0 }));

    for (const zeroConf of [false, true]) {
      makeUnaryRequest.mockClear();
      await actualLndApi.openChannelSync(
        {} as any,
        "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        Long.fromValue(100_000),
        Long.fromValue(5_000),
        true,
        zeroConf,
        false,
        "memo",
      );

      expect(makeUnaryRequest).toBeCalledTimes(1);
      const request = lnrpc.OpenChannelRequest.decode(
        makeUnaryRequest.mock.calls[0][2] as Uint8Array,
      );
      expect(request.minConfs).toBe(1);
      expect(request.spendUnconfirmed).toBe(false);
      expect(request.zeroConf).toBe(zeroConf);
    }

    makeUnaryRequest.mockRestore();
  });

  test("gives up after a deadline", async () => {
    const makeUnaryRequest = jest
      .spyOn(grpc, "grpcMakeUnaryRequest")
      .mockResolvedValue(lnrpc.ChannelPoint.create({ fundingTxidStr: "txid", outputIndex: 0 }));
    const before = Date.now();
    await actualLndApi.openChannelSync(
      {} as any,
      "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      Long.fromValue(100_000),
      Long.fromValue(5_000),
      true,
      false,
      false,
      "memo",
    );
    const options = makeUnaryRequest.mock.calls[0][4] as { deadline: number };
    expect(options.deadline).toBeGreaterThanOrEqual(before + actualLndApi.OPEN_CHANNEL_TIMEOUT_MS);
    expect(options.deadline).toBeLessThanOrEqual(Date.now() + actualLndApi.OPEN_CHANNEL_TIMEOUT_MS);
    makeUnaryRequest.mockRestore();
  });
});
