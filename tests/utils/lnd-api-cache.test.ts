const { cachedFor } = jest.requireActual("../../src/utils/lnd-api");

describe("cachedFor", () => {
  test("shares one answer per client within the time limit", async () => {
    let calls = 0;
    const load = jest.fn(async () => ++calls);
    const cached = cachedFor(1000, load);
    const lightning = {};

    expect(await cached(lightning, 0)).toBe(1);
    expect(await cached(lightning, 999)).toBe(1);
    expect(await cached({}, 999)).toBe(2); // another client
    expect(await cached(lightning, 1000)).toBe(3);
    expect(load).toHaveBeenCalledTimes(3);
  });

  test("doesn't keep a failed answer", async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error("lnd unavailable"))
      .mockResolvedValueOnce("ok");
    const cached = cachedFor(1000, load);
    const lightning = {};

    await expect(cached(lightning, 0)).rejects.toThrow("lnd unavailable");
    expect(await cached(lightning, 1)).toBe("ok");
  });
});
