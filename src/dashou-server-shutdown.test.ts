import assert from "node:assert/strict";
import test from "node:test";
import { closeHttpServer } from "./dashou-server.js";

type TestHttpServer = Parameters<typeof closeHttpServer>[0];

let finishHttpClose: (() => void) | undefined;
let applicationClosed = false;
const shutdown = closeHttpServer(
  {
    close(callback: (error?: Error) => void) {
      finishHttpClose = () => callback();
    },
  } as unknown as TestHttpServer,
  async () => {
    applicationClosed = true;
  },
);

await Promise.resolve();
assert.equal(applicationClosed, true);
finishHttpClose?.();
await shutdown;
assert.equal(applicationClosed, true);

const alreadyStoppedError = Object.assign(new Error("Server is not running."), {
  code: "ERR_SERVER_NOT_RUNNING",
});
await closeHttpServer(
  {
    close(callback: (error?: Error) => void) {
      callback(alreadyStoppedError);
    },
  } as unknown as TestHttpServer,
  async () => undefined,
);
