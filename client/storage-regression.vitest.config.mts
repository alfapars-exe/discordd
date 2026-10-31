import base from "./vitest.config.ts";
export default {
  ...base,
  cacheDir: "../migration/.local/legacy-vitest-cache",
  test: {
    ...base.test,
    include: [
      "src/crypto/keyStorage.test.ts",
      "src/crypto/pendingGroupSendStorage.test.ts",
    ],
  },
};
