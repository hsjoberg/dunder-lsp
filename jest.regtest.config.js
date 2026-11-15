// Integration tests against the regtest network (see regtest/regtest.mjs).
// Unlike jest.config.js there are no lnd mocks: Dunder talks to real lnd.
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\.tsx?$": ["ts-jest", { tsconfig: "./tsconfig-tests.json" }],
  },
  roots: ["<rootDir>/regtest"],
  testMatch: ["**/*.regtest.ts"],
  testTimeout: 180_000,
};
