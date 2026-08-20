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
    { application_id: "req_one", stage: "first_launch", outcome: "ok", error_code: null, client_unix_seconds: Math.floor(Date.parse("2026-08-20T10:00:00.000Z") / 1_000), received_at: "2026-08-20T10:00:01.000Z" },
    { application_id: "req_one", stage: "first_mcp_use", outcome: "ok", error_code: null, client_unix_seconds: Math.floor(Date.parse("2026-08-20T10:20:00.000Z") / 1_000), received_at: "2026-08-20T10:20:01.000Z" },
    { application_id: "req_two", stage: "application_status_failed", outcome: "error", error_code: "CONTROL_TIMEOUT", client_unix_seconds: Math.floor(Date.parse("2026-08-20T11:00:00.000Z") / 1_000), received_at: "2026-08-20T11:00:01.000Z" },
  ];

  const analytics = buildAdminAnalytics(applications, events, now);
  assert.deepEqual(analytics.funnel.map((step) => step.count), [2, 1, 1, 1]);
  assert.equal(analytics.funnel[3].conversionRate, 50);
  assert.equal(analytics.durations[1].medianSeconds, 420);
  assert.equal(analytics.durations[2].medianSeconds, 600);
  assert.equal(analytics.errors[0].errorCode, "CONTROL_TIMEOUT");
  assert.equal(analytics.bottlenecks.find((item) => item.key === "pending_review").count, 1);
  assert.equal(analytics.coverage.firstLaunchRate, 50);
});
