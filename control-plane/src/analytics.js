const MINUTE = 60;
const HOUR = 60 * MINUTE;

const BOTTLENECK_RULES = [
  { key: "pending_review", label: "待审核超过 30 分钟", statuses: ["pending"], timestamp: "created_at", thresholdSeconds: 30 * MINUTE * 1 },
  { key: "provisioning", label: "开通准备超过 5 分钟", statuses: ["provisioning"], timestamp: "provisioning_started_at", thresholdSeconds: 5 * MINUTE },
  { key: "awaiting_activation", label: "批准后超过 30 分钟未领取", statuses: ["approved"], timestamp: "approved_at", thresholdSeconds: 30 * MINUTE },
  { key: "activated_without_use", label: "已开通超过 24 小时未首次使用", statuses: ["activated"], timestamp: "activated_at", thresholdSeconds: 24 * HOUR, requiresNoFirstUse: true },
];

export function buildAdminAnalytics(applicationRows = [], eventRows = [], now = Date.now()) {
  const applications = Array.isArray(applicationRows) ? applicationRows : [];
  const events = Array.isArray(eventRows) ? eventRows : [];
  const eventsByApplication = new Map();
  for (const event of events) {
    const list = eventsByApplication.get(event.application_id) ?? [];
    list.push(event);
    eventsByApplication.set(event.application_id, list);
  }

  const firstSeenByApplication = firstSuccessfulEventByStages(eventsByApplication, ["first_seen", "first_launch"]);
  const firstConnectionByApplication = firstSuccessfulEventByStages(eventsByApplication, ["first_mcp_connection", "first_mcp_use"]);
  const firstAttemptByApplication = firstSuccessfulEventByStages(eventsByApplication, ["first_tool_call_attempt", "first_mcp_use"]);
  const firstUseByApplication = firstSuccessfulEventByStages(eventsByApplication, ["first_tool_call_success", "first_mcp_use"]);
  const submitted = applications.length;
  const approved = applications.filter((application) => application.approved_at).length;
  const activated = applications.filter((application) => application.activated_at).length;
  const firstUse = firstUseByApplication.size;
  const connected = milestoneApplicationCount(firstConnectionByApplication, firstAttemptByApplication, firstUseByApplication);
  const attempted = milestoneApplicationCount(firstAttemptByApplication, firstUseByApplication);
  const funnel = [
    funnelStep("submitted", "已提交申请", submitted, submitted),
    funnelStep("approved", "已批准", approved, submitted),
    funnelStep("activated", "已完成开通", activated, submitted),
    funnelStep("mcp_connected", "已连接 MCP", connected, submitted),
    funnelStep("tool_attempted", "已尝试工具", attempted, submitted),
    funnelStep("first_use", "工具调用成功", firstUse, submitted),
  ];

  const durations = [
    durationStep("submit_to_approval", "提交 → 批准", applications.map((application) => between(application.created_at, application.approved_at))),
    durationStep("approval_to_activation", "批准 → 开通", applications.map((application) => between(application.approved_at, application.activated_at))),
    durationStep("activation_to_connection", "开通 → MCP 连接", applications.map((application) => between(application.activated_at, eventTimestamp(firstConnectionByApplication.get(application.application_id))))),
    durationStep("connection_to_first_use", "MCP 连接 → 工具成功", applications.map((application) => between(eventTimestamp(firstConnectionByApplication.get(application.application_id)), eventTimestamp(firstUseByApplication.get(application.application_id))))),
    durationStep("activation_to_first_use", "开通 → 工具成功", applications.map((application) => between(application.activated_at, eventTimestamp(firstUseByApplication.get(application.application_id))))),
    durationStep("submit_to_first_use", "提交 → 工具成功", applications.map((application) => between(application.created_at, eventTimestamp(firstUseByApplication.get(application.application_id))))),
  ];

  const bottlenecks = BOTTLENECK_RULES.map((rule) => {
    const candidates = applications
      .filter((application) => rule.statuses.includes(application.status))
      .filter((application) => !rule.requiresNoFirstUse || !firstUseByApplication.has(application.application_id))
      .map((application) => {
        const startedAt = Date.parse(application[rule.timestamp] ?? "");
        const waitingSeconds = Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1_000)) : 0;
        return { application, waitingSeconds };
      })
      .filter(({ waitingSeconds }) => waitingSeconds >= rule.thresholdSeconds)
      .sort((left, right) => right.waitingSeconds - left.waitingSeconds);
    return {
      key: rule.key,
      label: rule.label,
      thresholdMinutes: Math.round(rule.thresholdSeconds / MINUTE),
      count: candidates.length,
      applications: candidates.slice(0, 20).map(({ application, waitingSeconds }) => ({
        applicationId: application.application_id,
        status: application.status,
        deviceName: application.device_name,
        nickname: application.nickname ?? null,
        waitingSeconds,
      })),
    };
  });

  const errors = [...countErrors(events).entries()]
    .map(([key, count]) => {
      const [stage, errorCode] = key.split("\u0000");
      return { stage, errorCode: errorCode || null, count };
    })
    .sort((left, right) => right.count - left.count || left.stage.localeCompare(right.stage))
    .slice(0, 8);

  return {
    generatedAt: new Date(now).toISOString(),
    funnel,
    durations,
    bottlenecks,
    errors,
    coverage: {
      applications: submitted,
      firstSeen: firstSeenByApplication.size,
      firstMcpConnection: firstConnectionByApplication.size,
      firstToolAttempt: firstAttemptByApplication.size,
      firstToolSuccess: firstUse,
      firstUse,
      firstSeenRate: ratio(firstSeenByApplication.size, submitted),
      firstUseRate: ratio(firstUse, submitted),
    },
  };
}

function firstSuccessfulEventByStages(eventsByApplication, stages) {
  const result = new Map();
  for (const [applicationId, events] of eventsByApplication) {
    const matching = events
      .filter((event) => stages.includes(event.stage) && event.outcome === "ok")
      .sort((left, right) => eventTimestamp(left) - eventTimestamp(right));
    if (matching[0]) result.set(applicationId, matching[0]);
  }
  return result;
}

function milestoneApplicationCount(...milestones) {
  return new Set(milestones.flatMap((milestone) => [...milestone.keys()])).size;
}

function countErrors(events) {
  const result = new Map();
  for (const event of events) {
    if (event.outcome !== "error") continue;
    const key = `${event.stage}\u0000${event.error_code ?? ""}`;
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function funnelStep(key, label, count, total) {
  return { key, label, count, conversionRate: ratio(count, total) };
}

function durationStep(key, label, values) {
  const seconds = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  return {
    key,
    label,
    count: seconds.length,
    medianSeconds: percentile(seconds, 0.5),
    p90Seconds: percentile(seconds, 0.9),
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentileValue) - 1));
  return values[index];
}

function between(start, end) {
  const startMs = timestampMillis(start);
  const endMs = timestampMillis(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.floor((endMs - startMs) / 1_000);
}

function timestampMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : NaN;
}

function eventTimestamp(event) {
  if (!event) return null;
  const clientSeconds = Number(event.client_unix_seconds);
  if (Number.isSafeInteger(clientSeconds) && clientSeconds > 0) return clientSeconds * 1_000;
  const receivedMs = Date.parse(event.received_at ?? "");
  return Number.isFinite(receivedMs) ? receivedMs : null;
}

function ratio(value, total) {
  return total > 0 ? Math.round((value / total) * 10_000) / 100 : 0;
}
