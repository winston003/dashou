import assert from "node:assert/strict";
import test from "node:test";
import { assertControlPlaneCompatible } from "./check-control-plane-client-compatibility.mjs";

test("accepts a newer compatible control-plane API regardless of service version", () => {
  assert.deepEqual(
    assertControlPlaneCompatible(
      { serviceVersion: "9.4.0", apiVersion: 3, capabilities: ["eventsV1"] },
      { requiredApiVersion: 2, requiredCapabilities: ["eventsV1"] },
    ),
    { serviceVersion: "9.4.0", onlineApiVersion: 3, requiredApiVersion: 2 },
  );
});

test("rejects a legacy service without apiVersion", () => {
  assert.throws(
    () => assertControlPlaneCompatible({ version: "0.1.3-rc.16" }, { requiredApiVersion: 1 }),
    /does not advertise apiVersion/,
  );
});

test("rejects an API below the desktop requirement", () => {
  assert.throws(
    () => assertControlPlaneCompatible({ apiVersion: 1 }, { requiredApiVersion: 2 }),
    /below required API/,
  );
});

test("rejects a missing explicitly required capability", () => {
  assert.throws(
    () => assertControlPlaneCompatible(
      { apiVersion: 1, capabilities: [] },
      { requiredApiVersion: 1, requiredCapabilities: ["eventsV1"] },
    ),
    /eventsV1/,
  );
});
