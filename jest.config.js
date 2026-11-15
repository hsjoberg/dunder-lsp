module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "./tsconfig-tests.json" }],
  },
  setupFiles: ["./jestSetup.js"],
  // Several app-level tests build the whole server and wait on timers. Jest's
  // 5s default is too tight when the machine is busy (other test workers, a
  // build), which made them fail intermittently.
  testTimeout: 20_000,
};
