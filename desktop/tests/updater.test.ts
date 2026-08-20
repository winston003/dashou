import assert from "node:assert/strict";
import test from "node:test";
import { installDownloadedUpdate } from "../src/bridge";

test("update downloads before stopping the runtime and relaunching", async () => {
  const actions: string[] = [];
  await installDownloadedUpdate(
    {
      download: async () => { actions.push("download"); },
      install: async () => { actions.push("install"); },
    },
    async (command) => { actions.push(command); },
    async () => { actions.push("relaunch"); },
  );

  assert.deepEqual(actions, ["download", "prepare_for_update", "install", "relaunch"]);
});

test("update failure attempts to restore the current runtime", async () => {
  const actions: string[] = [];
  await assert.rejects(
    installDownloadedUpdate(
      {
        download: async () => { actions.push("download"); },
        install: async () => {
          actions.push("install");
          throw new Error("installer failed");
        },
      },
      async (command) => { actions.push(command); },
      async () => { actions.push("relaunch"); },
    ),
    /installer failed/,
  );

  assert.deepEqual(actions, ["download", "prepare_for_update", "install", "restart_runtime"]);
});

test("preparation failure also attempts to restore the current runtime", async () => {
  const actions: string[] = [];
  await assert.rejects(
    installDownloadedUpdate(
      {
        download: async () => { actions.push("download"); },
        install: async () => { actions.push("install"); },
      },
      async (command) => {
        actions.push(command);
        if (command === "prepare_for_update") throw new Error("prepare failed");
      },
      async () => { actions.push("relaunch"); },
    ),
    /prepare failed/,
  );

  assert.deepEqual(actions, ["download", "prepare_for_update", "restart_runtime"]);
});
