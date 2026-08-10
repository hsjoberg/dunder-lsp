import config from "config";
import Long from "long";

import {
  getFeeChargeSat,
  getMinimumPaymentSat,
} from "../../../../src/services/ondemand-channel/api/utils";

jest.mock("config", () => ({
  get: jest.fn(),
}));

describe("on-demand channel fee configuration", () => {
  beforeEach(() => {
    (config.get as jest.Mock).mockReset();
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
});
