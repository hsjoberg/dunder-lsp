// content-disposition (@fastify/static) and cookie (@fastify/cookie, fastify's
// inject) ship only as ES modules, and @fastify/cookie loads cookie with
// import(). Node handles both, but Jest can't, so these packages are compiled
// to CommonJS too (shared with jest.regtest.config.js).
const esmPackages = "(content-disposition|cookie|@fastify[\\\\/]cookie)";
const esmTransform = {
  [`node_modules[\\\\/]${esmPackages}[\\\\/].+\\.js$`]: [
    "ts-jest",
    { tsconfig: "./tsconfig-tests.json" },
  ],
};
const transformIgnorePatterns = [`node_modules[\\\\/](?!${esmPackages}[\\\\/])`];

module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "./tsconfig-tests.json" }],
    ...esmTransform,
  },
  transformIgnorePatterns,
  setupFiles: ["./jestSetup.js"],
  // Several app-level tests build the whole server and wait on timers. Jest's
  // 5s default is too tight when the machine is busy (other test workers, a
  // build), which made them fail intermittently.
  testTimeout: 20_000,
};
