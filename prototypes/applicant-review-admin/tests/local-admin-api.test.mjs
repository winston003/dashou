import assert from "node:assert/strict";
import test from "node:test";
import {
  isLoopbackAddress,
  isSameOriginRequest,
  resolveAdminRoute,
} from "../local-admin-api.mjs";

const applicationId = "req_abcdefghijklmnop";

test("allows only the application review route shapes", () => {
  assert.deepEqual(resolveAdminRoute("GET", "/applications"), {
    method: "GET",
    upstreamPath: "/admin/applications",
  });
  assert.deepEqual(resolveAdminRoute("GET", "/applications?status=pending"), {
    method: "GET",
    upstreamPath: "/admin/applications?status=pending",
  });
  assert.deepEqual(resolveAdminRoute("GET", `/applications/${applicationId}`), {
    method: "GET",
    upstreamPath: `/admin/applications/${applicationId}`,
  });
  assert.deepEqual(resolveAdminRoute("GET", "/analytics"), {
    method: "GET",
    upstreamPath: "/admin/analytics",
  });
  assert.deepEqual(resolveAdminRoute("POST", `/applications/${applicationId}/approve`), {
    method: "POST",
    upstreamPath: `/admin/applications/${applicationId}/approve`,
  });
  assert.deepEqual(resolveAdminRoute("POST", `/applications/${applicationId}/reject`), {
    method: "POST",
    upstreamPath: `/admin/applications/${applicationId}/reject`,
  });
  for (const action of ["reopen", "period", "extend", "notes", "revoke", "retire", "restore", "authorization", "profile", "subject"]) {
    assert.deepEqual(resolveAdminRoute("POST", `/applications/${applicationId}/${action}`), {
      method: "POST",
      upstreamPath: `/admin/applications/${applicationId}/${action}`,
    });
  }
});

test("rejects reset, revoke, accounts, malformed ids, and unexpected query keys", () => {
  assert.equal(resolveAdminRoute("POST", "/reset"), null);
  assert.equal(resolveAdminRoute("GET", "/pilot/accounts"), null);
  assert.equal(resolveAdminRoute("GET", "/applications/req_short"), null);
  assert.equal(resolveAdminRoute("GET", "/applications?status=pending&token=leak"), null);
  assert.equal(resolveAdminRoute("DELETE", `/applications/${applicationId}`), null);
});

test("accepts only loopback callers", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.42"), false);
  assert.equal(isLoopbackAddress("10.0.0.8"), false);
});

test("requires an exact same-origin host for write requests", () => {
  assert.equal(isSameOriginRequest({ headers: { origin: "http://localhost:4173", host: "localhost:4173" } }), true);
  assert.equal(isSameOriginRequest({ headers: { origin: "https://example.com", host: "localhost:4173" } }), false);
  assert.equal(isSameOriginRequest({ headers: { host: "localhost:4173" } }), false);
});
