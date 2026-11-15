const { grpcChannelOptionsFor, GRPC_CHANNEL_OPTIONS } = jest.requireActual("../../src/utils/grpc");

describe("grpcChannelOptionsFor", () => {
  test("leaves hostname targets alone", () => {
    expect(grpcChannelOptionsFor("localhost:10009")).toEqual(GRPC_CHANNEL_OPTIONS);
    expect(grpcChannelOptionsFor("lnd.example.com:10009")).toEqual(GRPC_CHANNEL_OPTIONS);
  });

  test("uses a hostname as TLS server name for IP targets (Node 25 rejects IPs)", () => {
    for (const target of ["127.0.0.1:10009", "10.0.0.5:10009", "[::1]:10009", "127.0.0.1"]) {
      expect(grpcChannelOptionsFor(target)).toEqual({
        ...GRPC_CHANNEL_OPTIONS,
        "grpc.ssl_target_name_override": "localhost",
      });
    }
    expect(grpcChannelOptionsFor("10.0.0.5:10009", "lnd.internal")).toMatchObject({
      "grpc.ssl_target_name_override": "lnd.internal",
    });
  });
});
