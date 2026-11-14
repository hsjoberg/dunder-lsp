import config from "config";
import Long from "long";

import {
  getFeeChargeSat,
  getMinimumPaymentSat,
  isChannelOpeningEnabled,
} from "../../../../src/services/ondemand-channel/api/utils";

jest.mock("config", () => ({
  get: jest.fn(),
  has: jest.fn(),
}));

describe("on-demand channel fee configuration", () => {
  beforeEach(() => {
    (config.get as jest.Mock).mockReset();
    (config.has as jest.Mock).mockReset();
  });

  test("uses the configured minimum payment multiplier", () => {
    (config.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "minimumPaymentMultiplier") {
        return 3;
      }
      if (key === "fee.subsidyFactor") {
        return 0.5;
      }
      throw new Error(`Unexpected config key ${key}`);
    });

    expect(getFeeChargeSat(Long.fromValue(11))).toBe(5);
    expect(getMinimumPaymentSat(Long.fromValue(11))).toBe(15);
  });

  test("allows a fully subsidized fee", () => {
    (config.get as jest.Mock).mockReturnValue(0);

    expect(getFeeChargeSat(Long.fromValue(100))).toBe(0);
  });

  test("always leaves a positive channel push at the advertised minimum", () => {
    (config.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "minimumPaymentMultiplier") {
        return 1;
      }
      if (key === "fee.subsidyFactor") {
        return 1;
      }
      throw new Error(`Unexpected config key ${key}`);
    });

    expect(getMinimumPaymentSat(Long.fromValue(100))).toBe(101);
  });

  test("advertises at least one satoshi when the fee is fully subsidized", () => {
    (config.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "minimumPaymentMultiplier") {
        return 1;
      }
      if (key === "fee.subsidyFactor") {
        return 0;
      }
      throw new Error(`Unexpected config key ${key}`);
    });

    expect(getMinimumPaymentSat(Long.ZERO)).toBe(1);
  });

  test("enables channel opening when channelOpeningEnabled is not configured", () => {
    (config.has as jest.Mock).mockReturnValue(false);

    expect(isChannelOpeningEnabled()).toBe(true);
    expect(config.get).not.toBeCalled();
  });

  test("follows a configured channelOpeningEnabled boolean", () => {
    (config.has as jest.Mock).mockReturnValue(true);

    (config.get as jest.Mock).mockReturnValue(false);
    expect(isChannelOpeningEnabled()).toBe(false);

    (config.get as jest.Mock).mockReturnValue(true);
    expect(isChannelOpeningEnabled()).toBe(true);
  });

  test("rejects a non-boolean channelOpeningEnabled", () => {
    (config.has as jest.Mock).mockReturnValue(true);
    (config.get as jest.Mock).mockReturnValue("false");

    expect(() => isChannelOpeningEnabled()).toThrow("channelOpeningEnabled must be a boolean");
  });
});
