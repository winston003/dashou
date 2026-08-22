import assert from "node:assert/strict";
import test from "node:test";
import { assertNoControlPlaneRegression } from "./check-control-plane-deploy-compatibility.mjs";

const candidate = {
  serviceVersion: "2.0.0",
  apiVersion: 2,
  capabilities: ["analyticsV1", "reviewV1"],
};

test("accepts a legacy online service during first metadata rollout", () => {
  assert.equal(assertNoControlPlaneRegression({ version: "0.1.3-rc.16" }, candidate).onlineApiVersion, 0);
});

test("rejects an API downgrade", () => {
  assert.throws(
    () => assertNoControlPlaneRegression({ apiVersion: 3, capabilities: [] }, candidate),
    /Refusing API downgrade/,
  );
});

test("rejects removal of an online capability", () => {
  assert.throws(
    () => assertNoControlPlaneRegression({ apiVersion: 1, capabilities: ["analyticsV1", "retireV1"] }, candidate),
    /retireV1/,
  );
});

test("accepts equal API with a capability superset", () => {
  assert.equal(
    assertNoControlPlaneRegression({ apiVersion: 2, capabilities: ["analyticsV1"] }, candidate).candidateApiVersion,
    2,
  );
});
