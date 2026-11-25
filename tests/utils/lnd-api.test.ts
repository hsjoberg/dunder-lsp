import Long from "long";
import { Reader } from "protobufjs/minimal";

import * as grpc from "../../src/utils/grpc";
import { lnrpc } from "../../src/proto";

const actualLndApi = jest.requireActual("../../src/utils/lnd-api");

describe("bumpForceCloseFee", () => {
  test("encodes lnd's BumpForceCloseFeeRequest", async () => {
    const makeUnaryRequest = jest.spyOn(grpc, "grpcMakeUnaryRequest").mockResolvedValue({});
    await actualLndApi.bumpForceCloseFee({} as any, "ab".repeat(32) + ":2", 10, 12_345);

    expect(makeUnaryRequest.mock.calls[0][1]).toBe("/walletrpc.WalletKit/BumpForceCloseFee");
    // Field numbers from lnd v0.21 walletkit.proto.
    const reader = Reader.create(makeUnaryRequest.mock.calls[0][2] as Uint8Array);
    const fields: Record<number, unknown> = {};
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const field = tag >>> 3;
      if (field === 1) {
        fields[1] = lnrpc.ChannelPoint.decode(reader, reader.uint32());
      } else if (field === 2) {
        fields[2] = reader.uint32();
      } else if (field === 4) {
        fields[4] = reader.bool();
      } else if (field === 5) {
        fields[5] = Number(reader.uint64());
      } else {
        throw new Error(`Unexpected field ${field}`);
      }
    }
    expect(fields[1]).toMatchObject({ fundingTxidStr: "ab".repeat(32), outputIndex: 2 });
    expect(fields[2]).toBe(10);
    expect(fields[4]).toBe(true);
    expect(fields[5]).toBe(12_345);
    // A deadline, so a stuck call can't stall the guard.
    const options = makeUnaryRequest.mock.calls[0][4] as { deadline: number };
    expect(options.deadline).toBeLessThanOrEqual(
      Date.now() + actualLndApi.BUMP_FORCE_CLOSE_FEE_TIMEOUT_MS,
    );
    expect(options.deadline).toBeGreaterThan(Date.now());
    makeUnaryRequest.mockRestore();
  });
});

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
