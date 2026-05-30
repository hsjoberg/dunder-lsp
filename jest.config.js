module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "./tsconfig-tests.json" }],
  },
  setupFiles: ["./jestSetup.js"],
};
