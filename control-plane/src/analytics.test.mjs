import assert from "node:assert/strict";
import test from "node:test";
import { buildAdminAnalytics } from "./analytics.js";

test("admin analytics calculates funnel, durations, errors and stuck applications", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const applications = [
    {
      application_id: "req_one",
      status: "activated",
      device_name: "Alice Mac",
      nickname: "搭手·小麦-3211",
      created_at: "2026-08-20T10:00:00.000Z",
      provisioning_started_at: "2026-08-20T10:01:00.000Z",
      approved_at: "2026-08-20T10:03:00.000Z",
      activated_at: "2026-08-20T10:10:00.000Z",
    },
    {
      application_id: "req_two",
      status: "pending",
      device_name: "Bob PC",
      nickname: null,
      created_at: "2026-08-20T11:00:00.000Z",
      provisioning_started_at: null,
      approved_at: null,
      activated_at: null,
    },
  ];
  const events = [
    { application_id: "req_one", stage: "first_seen", outcome: "ok", error_code: null, client_unix_seconds: Math.floor(Date.parse("2026-08-20T10:00:00.000Z") / 1_000), received_at: "2026-08-20T10:00:01.000Z" },
    { application_id: "req_one", stage: "first_mcp_connection", outcome: "ok", error_code: null, client_unix_seconds: Math.floor(Date.parse("2026-08-20T10:15:00.000Z") / 1_000), received_at: "2026-08-20T10:15:01.000Z" },
    { application_id: "req_one", stage: "first_tool_call_attempt", outcome: "ok", error_code: null, client_unix_seconds: Math.floor(Date.parse("2026-08-20T10:18:00.000Z") / 1_000), received_at: "2026-08-20T10:18:01.000Z" },
    { application_id: "req_one", stage: "first_tool_call_success", outcome: "ok", error_code: null, client_unix_seconds: Math.floor(Date.parse("2026-08-20T10:20:00.000Z") / 1_000), received_at: "2026-08-20T10:20:01.000Z" },
    { application_id: "req_one", stage: "first_tool_call_failure", outcome: "error", error_code: "PROJECT_NOT_OPEN", client_unix_seconds: Math.floor(Date.parse("2026-08-20T10:19:00.000Z") / 1_000), received_at: "2026-08-20T10:19:01.000Z" },
    { application_id: "req_two", stage: "application_status_failed", outcome: "error", error_code: "CONTROL_TIMEOUT", client_unix_seconds: Math.floor(Date.parse("2026-08-20T11:00:00.000Z") / 1_000), received_at: "2026-08-20T11:00:01.000Z" },
  ];

  const analytics = buildAdminAnalytics(applications, events, now);
  assert.deepEqual(analytics.funnel.map((step) => step.count), [2, 1, 1, 1, 1, 1]);
  assert.equal(analytics.funnel[5].conversionRate, 50);
  assert.equal(analytics.durations[1].medianSeconds, 420);
  assert.equal(analytics.durations[3].medianSeconds, 300);
  assert.equal(analytics.durations[4].medianSeconds, 600);
  assert.deepEqual(analytics.errors.map((item) => item.errorCode).sort(), ["CONTROL_TIMEOUT", "PROJECT_NOT_OPEN"]);
  assert.equal(analytics.bottlenecks.find((item) => item.key === "pending_review").count, 1);
  assert.equal(analytics.coverage.firstSeenRate, 50);
});

test("later milestone receipt keeps the funnel monotonic while earlier events retry", () => {
  const applications = [{
    application_id: "req_partial",
    status: "activated",
    device_name: "Partial delivery",
    created_at: "2026-08-20T10:00:00.000Z",
    approved_at: "2026-08-20T10:01:00.000Z",
    activated_at: "2026-08-20T10:02:00.000Z",
  }];
  const events = [{
    application_id: "req_partial",
    stage: "first_tool_call_success",
    outcome: "ok",
    error_code: null,
    client_unix_seconds: Math.floor(Date.parse("2026-08-20T10:03:00.000Z") / 1_000),
    received_at: "2026-08-20T10:03:01.000Z",
  }];
  const analytics = buildAdminAnalytics(applications, events, Date.parse("2026-08-20T10:04:00.000Z"));
  assert.deepEqual(analytics.funnel.map((step) => step.count), [1, 1, 1, 1, 1, 1]);
  assert.equal(analytics.coverage.firstMcpConnection, 0);
});
