// Integration tests against the regtest network (see regtest/regtest.mjs).
// Unlike jest.config.js there are no lnd mocks: Dunder talks to real lnd.
const { transform, transformIgnorePatterns } = require("./jest.config.js");

module.exports = {
  testEnvironment: "node",
  transform,
  transformIgnorePatterns,
  roots: ["<rootDir>/regtest"],
  testMatch: ["**/*.regtest.ts"],
  testTimeout: 180_000,
};
