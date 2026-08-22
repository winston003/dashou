import { deleteDeviceTunnel, provisionDeviceTunnel } from "./cloudflare.js";
import { buildAdminAnalytics } from "./analytics.js";
import { controlPlaneHealth } from "./service-metadata.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const APPLICATION_ID_PATTERN = /^req_[A-Za-z0-9_-]{16,64}$/;
const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{16,96}$/;
const APPLICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const PERIODS = new Set(["week", "month", "quarter", "year"]);
const DEFAULT_LEASE_TTL_SECONDS = 15 * 60;
const RESET_CONFIRMATION = "DELETE_ALL_DASHOU_PILOT_DATA";
const CLIENT_EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_-]{12,96}$/;
const DEVICE_NICKNAME_PATTERN = /^搭手·[\p{L}\p{N}]{1,16}-\d{4}$/u;
const DEVICE_FINGERPRINT_PATTERN = /^[A-F0-9]{4}-[A-F0-9]{4}$/;
const SUBJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const RESOURCE_SLOT_STATES = new Set(["provisioning", "active", "needs_reconcile", "deleting", "delete_failed"]);
const DEFAULT_MAX_ACTIVE_RESOURCES = 180;
const CLIENT_EVENT_STAGES = new Set([
  "app_opened",
  "first_seen",
  "first_launch",
  "application_submit_started",
  "application_submitted",
  "application_submit_failed",
  "application_status_failed",
  "activation_completed",
  "folders_selected",
  "runtime_start_started",
  "runtime_started",
  "runtime_start_failed",
  "chatgpt_opened",
  "connection_password_copied",
  "folder_added",
  "folder_removed",
  "runtime_recovering",
  "runtime_blocked",
  "update_checked",
  "update_install_started",
  "update_install_failed",
  "notification_enabled",
  "runtime_ready",
  "chatgpt_setup_opened",
  "oauth_completed",
  "first_mcp_session",
  "first_tool_success",
  "connection_ready",
  "diagnostics_copied",
  "first_mcp_connection",
  "first_tool_call_attempt",
  "first_tool_call_success",
  "first_tool_call_failure",
  "first_mcp_use",
]);

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(JSON.stringify({ event: "pilot_control_error", message: errorMessage(error) }));
      return json({ error: publicErrorMessage(error) }, errorStatus(error));
    }
  },
};

export async function route(request, env) {
  try {
    return await routeRequest(request, env);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    throw error;
  }
}

async function routeRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return json(controlPlaneHealth(env.DASHOU_BUILD_SHA ?? "dev"));
  }
  if (request.method === "GET" && url.pathname === "/pilot-policy") return pilotPolicy(request, env);
  if (request.method === "POST" && url.pathname === "/applications") return createApplication(request, env);

  const activationConfirmMatch = /^\/applications\/([^/]+)\/activate\/confirm$/.exec(url.pathname);
  if (activationConfirmMatch && request.method === "POST") {
    return confirmActivation(request, env, decodeURIComponent(activationConfirmMatch[1]));
  }
  const activationMatch = /^\/applications\/([^/]+)\/activate$/.exec(url.pathname);
  if (activationMatch && request.method === "POST") {
    return activateApplication(request, env, decodeURIComponent(activationMatch[1]));
  }
  const applicationMatch = /^\/applications\/([^/]+)$/.exec(url.pathname);
  if (applicationMatch && request.method === "GET") {
    return applicationStatus(request, env, decodeURIComponent(applicationMatch[1]));
  }
  const applicationEventsMatch = /^\/applications\/([^/]+)\/events$/.exec(url.pathname);
  if (applicationEventsMatch && request.method === "POST") {
    return recordApplicationEvents(request, env, decodeURIComponent(applicationEventsMatch[1]));
  }

  if (url.pathname === "/admin/applications" && request.method === "GET") return adminApplicationList(request, env, url);
  if (url.pathname === "/admin/analytics" && request.method === "GET") return adminAnalytics(request, env);
  if (url.pathname === "/admin/reset" && request.method === "POST") return adminReset(request, env);
  const adminApplicationMatch = /^\/admin\/applications\/([^/]+)$/.exec(url.pathname);
  if (adminApplicationMatch && request.method === "GET") {
    return adminApplicationDetail(request, env, decodeURIComponent(adminApplicationMatch[1]));
  }
  const approveMatch = /^\/admin\/applications\/([^/]+)\/approve$/.exec(url.pathname);
  if (approveMatch && request.method === "POST") {
    return adminApproveApplication(request, env, decodeURIComponent(approveMatch[1]));
  }
  const rejectMatch = /^\/admin\/applications\/([^/]+)\/reject$/.exec(url.pathname);
  if (rejectMatch && request.method === "POST") {
    return adminRejectApplication(request, env, decodeURIComponent(rejectMatch[1]));
  }
  const reopenMatch = /^\/admin\/applications\/([^/]+)\/reopen$/.exec(url.pathname);
  if (reopenMatch && request.method === "POST") {
    return adminReopenApplication(request, env, decodeURIComponent(reopenMatch[1]));
  }
  const periodMatch = /^\/admin\/applications\/([^/]+)\/period$/.exec(url.pathname);
  if (periodMatch && request.method === "POST") {
    return adminChangeApplicationPeriod(request, env, decodeURIComponent(periodMatch[1]));
  }
  const extendMatch = /^\/admin\/applications\/([^/]+)\/extend$/.exec(url.pathname);
  if (extendMatch && request.method === "POST") {
    return adminExtendApplication(request, env, decodeURIComponent(extendMatch[1]));
  }
  const noteMatch = /^\/admin\/applications\/([^/]+)\/notes$/.exec(url.pathname);
  if (noteMatch && request.method === "POST") {
    return adminAddApplicationNote(request, env, decodeURIComponent(noteMatch[1]));
  }
  const revokeMatch = /^\/admin\/applications\/([^/]+)\/revoke$/.exec(url.pathname);
  if (revokeMatch && request.method === "POST") {
    return adminRevokeApplication(request, env, decodeURIComponent(revokeMatch[1]));
  }
  const retireMatch = /^\/admin\/applications\/([^/]+)\/retire$/.exec(url.pathname);
  if (retireMatch && request.method === "POST") {
    return adminRetireApplication(request, env, decodeURIComponent(retireMatch[1]));
  }
  const restoreMatch = /^\/admin\/applications\/([^/]+)\/restore$/.exec(url.pathname);
  if (restoreMatch && request.method === "POST") {
    return adminRestoreApplication(request, env, decodeURIComponent(restoreMatch[1]));
  }
  const subjectMatch = /^\/admin\/applications\/([^/]+)\/subject$/.exec(url.pathname);
  if (subjectMatch && request.method === "POST") {
    return adminSetApplicationSubject(request, env, decodeURIComponent(subjectMatch[1]));
  }
  const authorizationMatch = /^\/admin\/applications\/([^/]+)\/authorization$/.exec(url.pathname);
  if (authorizationMatch && request.method === "POST") {
    return adminEditAuthorization(request, env, decodeURIComponent(authorizationMatch[1]));
  }
  const profileMatch = /^\/admin\/applications\/([^/]+)\/profile$/.exec(url.pathname);
  if (profileMatch && request.method === "POST") {
    return adminEditApplicationProfile(request, env, decodeURIComponent(profileMatch[1]));
  }

  if (url.pathname === "/admin/pilot/accounts" && request.method === "GET") return adminList(request, env);
  if (url.pathname === "/admin/pilot/accounts" && request.method === "POST") return adminCreate(request, env);
  const accountMatch = /^\/admin\/pilot\/accounts\/([^/]+)$/.exec(url.pathname);
  if (accountMatch && request.method === "POST") return adminUpdate(request, env, decodeURIComponent(accountMatch[1]));
  return json({ error: "Not found" }, 404);
}

async function createApplication(request, env) {
  const body = await jsonObject(request);
  const applicationToken = requiredString(body.applicationToken, "applicationToken");
  if (!APPLICATION_TOKEN_PATTERN.test(applicationToken)) throw new HttpError(400, "applicationToken must be a base64url secret of at least 32 bytes");
  const deviceId = requiredString(body.deviceId, "deviceId");
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new HttpError(400, "deviceId is invalid");
  const deviceName = limitedDisplayString(body.deviceName, "deviceName", 100);
  const deviceNickname = body.deviceNickname == null ? null : limitedString(body.deviceNickname, "deviceNickname", 40);
  if (deviceNickname && !DEVICE_NICKNAME_PATTERN.test(deviceNickname)) throw new HttpError(400, "deviceNickname is invalid");
  const deviceFingerprint = body.deviceFingerprint == null ? null : limitedString(body.deviceFingerprint, "deviceFingerprint", 20);
  if (deviceFingerprint && !DEVICE_FINGERPRINT_PATTERN.test(deviceFingerprint)) throw new HttpError(400, "deviceFingerprint is invalid");
  const platform = limitedDisplayString(body.platform, "platform", 40);
  const contact = optionalLimitedDisplayString(body.contact, "contact", 200);
  const tokenHash = await sha256Base64Url(applicationToken);

  const existing = await env.DB.prepare(
    "SELECT application_id, application_token_hash, status, created_at, device_nickname, device_fingerprint FROM pilot_applications WHERE device_id = ?1 AND status IN ('pending', 'provisioning', 'approved', 'activated')",
  ).bind(deviceId).first();
  if (existing) {
    if (!constantTimeEqual(existing.application_token_hash, tokenHash)) {
      throw new HttpError(409, "This device already has an active application");
    }
    if ((deviceNickname && !existing.device_nickname) || (deviceFingerprint && !existing.device_fingerprint)) {
      await env.DB.prepare(
        "UPDATE pilot_applications SET device_nickname = COALESCE(device_nickname, ?1), device_fingerprint = COALESCE(device_fingerprint, ?2), updated_at = ?3 WHERE application_id = ?4",
      ).bind(deviceNickname, deviceFingerprint, new Date().toISOString(), existing.application_id).run();
    }
    return json({ applicationId: existing.application_id, status: existing.status, createdAt: existing.created_at });
  }

  await enforceApplicationRateLimit(request, env);

  const applicationId = `req_${randomToken().slice(0, 22)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO pilot_applications (application_id, application_token_hash, device_id, device_name, device_nickname, device_fingerprint, platform, contact, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?9)",
  ).bind(applicationId, tokenHash, deviceId, deviceName, deviceNickname, deviceFingerprint, platform, contact ?? null, now).run();
  return json({ applicationId, status: "pending", createdAt: now }, 201);
}

async function enforceApplicationRateLimit(request, env) {
  const address = request.headers.get("cf-connecting-ip")?.trim() || "local-or-unknown";
  const networkHash = await sha256Base64Url(address);
  const windowStart = new Date().toISOString().slice(0, 13);
  await env.DB.prepare(
    "INSERT INTO pilot_application_rate_limits (network_hash, window_start, attempts) VALUES (?1, ?2, 1) ON CONFLICT(network_hash, window_start) DO UPDATE SET attempts = attempts + 1",
  ).bind(networkHash, windowStart).run();
  const row = await env.DB.prepare(
    "SELECT attempts FROM pilot_application_rate_limits WHERE network_hash = ?1 AND window_start = ?2",
  ).bind(networkHash, windowStart).first();
  if (Number(row?.attempts) > 10) throw new HttpError(429, "Too many applications from this network; try again later");
}

async function applicationStatus(request, env, applicationId) {
  const row = await authorizedApplication(request, env, applicationId);
  return json(applicationStatusSummary(row));
}

async function recordApplicationEvents(request, env, applicationId) {
  const application = await authorizedApplication(request, env, applicationId);
  const body = await jsonObject(request);
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) {
    throw new HttpError(400, "events must contain between 1 and 50 items");
  }
  const receivedAt = new Date().toISOString();
  const statements = body.events.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new HttpError(400, "event must be an object");
    const eventId = requiredString(event.eventId, "eventId");
    if (!CLIENT_EVENT_ID_PATTERN.test(eventId)) throw new HttpError(400, "eventId is invalid");
    const stage = requiredString(event.stage, "stage");
    if (!CLIENT_EVENT_STAGES.has(stage)) throw new HttpError(400, "event stage is invalid");
    const outcome = requiredString(event.outcome, "outcome");
    if (!["ok", "error"].includes(outcome)) throw new HttpError(400, "event outcome is invalid");
    const errorCode = event.errorCode == null ? null : limitedString(event.errorCode, "errorCode", 48);
    if (errorCode && !/^[A-Z0-9_]{3,48}$/.test(errorCode)) throw new HttpError(400, "event errorCode is invalid");
    const appVersion = limitedString(event.appVersion, "appVersion", 40);
    const reportedDeviceNickname = event.deviceNickname == null
      ? application.device_nickname ?? null
      : limitedString(event.deviceNickname, "deviceNickname", 40);
    if (reportedDeviceNickname && !DEVICE_NICKNAME_PATTERN.test(reportedDeviceNickname)) {
      throw new HttpError(400, "event deviceNickname is invalid");
    }
    const reportedDeviceFingerprint = event.deviceFingerprint == null
      ? application.device_fingerprint ?? null
      : limitedString(event.deviceFingerprint, "deviceFingerprint", 20);
    if (reportedDeviceFingerprint && !DEVICE_FINGERPRINT_PATTERN.test(reportedDeviceFingerprint)) {
      throw new HttpError(400, "event deviceFingerprint is invalid");
    }
    const clientUnixSeconds = Number(event.unixSeconds);
    if (!Number.isSafeInteger(clientUnixSeconds) || clientUnixSeconds < 1_600_000_000 || clientUnixSeconds > 4_102_444_800) {
      throw new HttpError(400, "event unixSeconds is invalid");
    }
    return env.DB.prepare(
      "INSERT OR IGNORE INTO pilot_client_events (application_id, event_id, stage, outcome, error_code, app_version, client_unix_seconds, received_at, device_nickname, device_fingerprint) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    ).bind(applicationId, eventId, stage, outcome, errorCode, appVersion, clientUnixSeconds, receivedAt, reportedDeviceNickname, reportedDeviceFingerprint);
  });
  if (typeof env.DB.batch !== "function") throw new Error("D1 batch support is required");
  await env.DB.batch(statements);
  return json({ accepted: statements.length });
}

async function activateApplication(request, env, applicationId) {
  const row = await authorizedApplication(request, env, applicationId);
  if (row.status === "activated") throw new HttpError(410, "Activation has already been completed");
  if (row.status !== "approved" || !row.activation_ciphertext) {
    throw new HttpError(409, `Application is not ready for activation: ${row.status}`);
  }
  const activation = await decryptActivation(row.activation_ciphertext, env.DASHOU_ACTIVATION_KEY);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE pilot_applications SET activation_started_at = COALESCE(activation_started_at, ?1), updated_at = ?1 WHERE application_id = ?2 AND status = 'approved'",
  ).bind(now, applicationId).run();
  return json({ ...activation, applicationId, activationReceipt: await activationReceipt(applicationId, row.application_token_hash, env.DASHOU_ACTIVATION_KEY) });
}

async function confirmActivation(request, env, applicationId) {
  const row = await authorizedApplication(request, env, applicationId);
  if (row.status === "activated") return json(applicationStatusSummary(row));
  if (row.status !== "approved" || !row.activation_ciphertext) {
    throw new HttpError(409, `Application is not ready for activation: ${row.status}`);
  }
  const body = await jsonObject(request);
  const receipt = requiredString(body.activationReceipt, "activationReceipt");
  const expected = await activationReceipt(applicationId, row.application_token_hash, env.DASHOU_ACTIVATION_KEY);
  if (!constantTimeEqual(receipt, expected)) throw new HttpError(401, "Invalid activation receipt");
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE pilot_applications SET status = 'activated', activated_at = ?1, activation_ciphertext = NULL, updated_at = ?1 WHERE application_id = ?2 AND status = 'approved'",
  ).bind(now, applicationId).run();
  if (!changed(result)) throw new HttpError(409, "Application activation state changed; refresh and try again");
  return json({ ...applicationStatusSummary(row), status: "activated", activatedAt: now });
}

async function adminApplicationList(request, env, url) {
  requireAdmin(request, env);
  const status = url.searchParams.get("status")?.trim();
  if (status && !["pending", "provisioning", "approved", "rejected", "activated", "expired", "revoked"].includes(status)) {
    throw new HttpError(400, "Invalid application status filter");
  }
  const result = await env.DB.prepare("SELECT * FROM pilot_applications ORDER BY created_at").all();
  const rows = result.results ?? [];
  const visibleRows = status ? rows.filter((row) => row.status === status) : rows;
  return json({ resourcePolicy: resourcePolicySummary(env), applications: visibleRows.map((row) => adminApplicationSummary(row, rows)) });
}

async function adminApplicationDetail(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const row = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!row) throw new HttpError(404, `Application not found: ${applicationId}`);
  const [eventResult, auditResult, allApplications] = await Promise.all([
    env.DB.prepare(
      "SELECT event_id, stage, outcome, error_code, app_version, client_unix_seconds, received_at, device_nickname, device_fingerprint FROM pilot_client_events WHERE application_id = ?1 ORDER BY received_at, client_unix_seconds",
    ).bind(applicationId).all(),
    env.DB.prepare(
      "SELECT audit_id, actor, action, from_status, to_status, from_period, to_period, reason, note, request_id, created_at FROM pilot_admin_audit_events WHERE application_id = ?1 ORDER BY created_at, audit_id",
    ).bind(applicationId).all(),
    env.DB.prepare("SELECT * FROM pilot_applications ORDER BY created_at").all(),
  ]);
  return json({
    resourcePolicy: resourcePolicySummary(env),
    application: adminApplicationSummary(row, allApplications.results ?? []),
    relatedApplications: relatedApplicationSummaries(row, allApplications.results ?? []),
    events: (eventResult.results ?? []).map((event) => ({
      eventId: event.event_id,
      stage: event.stage,
      outcome: event.outcome,
      ...(event.error_code ? { errorCode: event.error_code } : {}),
      appVersion: event.app_version,
      unixSeconds: event.client_unix_seconds,
      receivedAt: event.received_at,
      ...(event.device_nickname ? { deviceNickname: event.device_nickname } : {}),
      ...(event.device_fingerprint ? { deviceFingerprint: event.device_fingerprint } : {}),
    })),
    auditEvents: (auditResult.results ?? []).map((event) => ({
      auditId: event.audit_id,
      actor: event.actor,
      action: event.action,
      ...(event.from_status ? { fromStatus: event.from_status } : {}),
      ...(event.to_status ? { toStatus: event.to_status } : {}),
      ...(event.from_period ? { fromPeriod: event.from_period } : {}),
      ...(event.to_period ? { toPeriod: event.to_period } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.note ? { note: event.note } : {}),
      requestId: event.request_id,
      createdAt: event.created_at,
    })),
  });
}

async function adminAnalytics(request, env) {
  requireAdmin(request, env);
  const [applicationResult, eventResult] = await Promise.all([
    env.DB.prepare(
      "SELECT application_id, status, device_name, nickname, created_at, provisioning_started_at, approved_at, activated_at FROM pilot_applications ORDER BY created_at",
    ).all(),
    env.DB.prepare(
      "SELECT application_id, stage, outcome, error_code, client_unix_seconds, received_at FROM pilot_client_events ORDER BY received_at, client_unix_seconds",
    ).all(),
  ]);
  return json(buildAdminAnalytics(applicationResult.results ?? [], eventResult.results ?? []));
}

async function adminReset(request, env) {
  requireAdmin(request, env);
  const body = await jsonObject(request);
  if (body.confirm !== RESET_CONFIRMATION) {
    throw new HttpError(400, `confirm must equal ${RESET_CONFIRMATION}`);
  }
  const result = await env.DB.prepare(
    "SELECT application_id, tunnel_id, hostname FROM pilot_applications WHERE deprovisioned_at IS NULL AND (tunnel_id IS NOT NULL OR hostname IS NOT NULL) ORDER BY created_at",
  ).all();
  const registeredDevices = (result.results ?? []).filter((row) => row.tunnel_id || row.hostname);
  const deprovisioner = typeof env.DEVICE_DEPROVISIONER === "function" ? env.DEVICE_DEPROVISIONER : deleteDeviceTunnel;
  const deletedDevices = [];
  for (const row of registeredDevices) {
    if (!row.tunnel_id || !row.hostname) {
      throw new HttpError(409, `Application ${row.application_id} has incomplete Cloudflare resource metadata`);
    }
    deletedDevices.push(await deprovisioner(env, { tunnelId: row.tunnel_id, hostname: row.hostname }));
  }
  if (typeof env.DB.batch !== "function") throw new Error("D1 batch support is required");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pilot_client_events"),
    env.DB.prepare("DELETE FROM pilot_admin_audit_events"),
    env.DB.prepare("DELETE FROM pilot_application_rate_limits"),
    env.DB.prepare("DELETE FROM pilot_applications"),
    env.DB.prepare("DELETE FROM pilot_accounts"),
  ]);
  return json({ reset: true, deletedDevices: deletedDevices.length });
}

async function adminApproveApplication(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const period = requiredString(body.period, "period");
  if (!PERIODS.has(period)) throw new HttpError(400, "period must be week, month, quarter or year");
  const subjectId = normalizedSubjectId(body.subjectId);
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  const recovering = current.status === "provisioning"
    && Number.isFinite(Date.parse(current.provisioning_started_at))
    && Date.parse(current.provisioning_started_at) < Date.now() - 5 * 60 * 1_000;
  if (current.status !== "pending" && !recovering) {
    throw new HttpError(409, `Application cannot be approved from status: ${current.status}`);
  }
  if (current.subject_id && current.subject_id !== subjectId) {
    throw new HttpError(409, `Application is already assigned to customer: ${current.subject_id}`);
  }
  const occupied = await env.DB.prepare(
    "SELECT application_id, status, resource_state FROM pilot_applications WHERE subject_id = ?1 AND application_id <> ?2 AND resource_state IN ('provisioning', 'active', 'needs_reconcile', 'deleting', 'delete_failed') LIMIT 1",
  ).bind(subjectId, applicationId).first();
  if (occupied) {
    throw new HttpError(409, `Customer ${subjectId} already owns a retained connection (${occupied.application_id}, ${occupied.resource_state}); retire it before approving a replacement`);
  }
  const hasCurrentSlot = current.subject_id === subjectId && RESOURCE_SLOT_STATES.has(current.resource_state);
  if (!hasCurrentSlot) {
    const resourceCount = await retainedResourceCount(env);
    const resourceLimit = maxActiveResources(env.DASHOU_MAX_ACTIVE_RESOURCES);
    if (resourceCount >= resourceLimit) {
      throw new HttpError(409, `Connection capacity guard reached (${resourceCount}/${resourceLimit}); retire an unused connection before approving another`);
    }
  }

  const provisioningStartedAt = new Date().toISOString();
  let claim;
  try {
    claim = recovering
      ? await env.DB.prepare(
        "UPDATE pilot_applications SET subject_id = ?1, resource_state = 'provisioning', resource_error = NULL, provisioning_started_at = ?2, updated_at = ?2 WHERE application_id = ?3 AND status = 'provisioning' AND provisioning_started_at = ?4",
      ).bind(subjectId, provisioningStartedAt, applicationId, current.provisioning_started_at).run()
      : await env.DB.prepare(
        "UPDATE pilot_applications SET status = 'provisioning', subject_id = ?1, resource_state = 'provisioning', resource_error = NULL, provisioning_started_at = ?2, updated_at = ?2 WHERE application_id = ?3 AND status = 'pending'",
      ).bind(subjectId, provisioningStartedAt, applicationId).run();
  } catch (error) {
    if (errorMessage(error).toLowerCase().includes("unique constraint")) {
      throw new HttpError(409, `Customer ${subjectId} acquired another connection while this approval was being processed; refresh and inspect related applications`);
    }
    throw error;
  }
  if (!changed(claim)) throw new HttpError(409, "Application is already being processed");

  try {
    const provisioner = typeof env.DEVICE_PROVISIONER === "function" ? env.DEVICE_PROVISIONER : provisionDeviceTunnel;
    const provisioned = await provisioner(env, { applicationId, deviceId: current.device_id });
    const approvedAt = new Date();
    const expiresAt = addAuthorizationPeriod(approvedAt, period).toISOString();
    const accountId = `device-${applicationId.slice(4)}`;
    validateAccountId(accountId);
    const pilotToken = randomToken();
    const pilotPolicyUrl = new URL("/pilot-policy", controlPublicUrl(request, env)).toString();
    const publicBaseUrl = normalizeHttpsBaseUrl(provisioned.publicBaseUrl);
    const activationCiphertext = await encryptActivation({
      accountId,
      expiresAt,
      publicBaseUrl,
      mcpUrl: new URL("/mcp", publicBaseUrl).toString(),
      tunnelToken: requiredString(provisioned.tunnelToken, "provisioned tunnelToken"),
      pilotToken,
      pilotPolicyUrl,
      pilotPublicKeyPem: requiredString(env.PILOT_LEASE_PUBLIC_KEY, "PILOT_LEASE_PUBLIC_KEY").replaceAll("\\n", "\n"),
    }, env.DASHOU_ACTIVATION_KEY);
    const approvedAtText = approvedAt.toISOString();
    const statements = [
      env.DB.prepare(
        "INSERT INTO pilot_accounts (account_id, token_hash, enabled, expires_at, created_at) VALUES (?1, ?2, 1, ?3, ?4)",
      ).bind(accountId, await sha256Base64Url(pilotToken), expiresAt, approvedAtText),
      env.DB.prepare(
        "UPDATE pilot_applications SET status = 'approved', resource_state = 'active', resource_error = NULL, period = ?1, account_id = ?2, tunnel_id = ?3, hostname = ?4, activation_ciphertext = ?5, approved_at = ?6, expires_at = ?7, updated_at = ?6 WHERE application_id = ?8 AND status = 'provisioning'",
      ).bind(period, accountId, requiredString(provisioned.tunnelId, "provisioned tunnelId"), requiredString(provisioned.hostname, "provisioned hostname"), activationCiphertext, approvedAtText, expiresAt, applicationId),
    ];
    statements.push(auditStatement(env, applicationId, "approved", auditContext(env, approvedAtText), {
      fromStatus: current.status === "provisioning" ? "pending" : current.status,
      toStatus: "approved",
      toPeriod: period,
      note: `customer: ${subjectId}`,
    }));
    if (typeof env.DB.batch !== "function") throw new Error("D1 batch support is required");
    await env.DB.batch(statements);
    return json({ applicationId, status: "approved", period, approvedAt: approvedAtText, expiresAt, mcpUrl: new URL("/mcp", publicBaseUrl).toString() });
  } catch (error) {
    await env.DB.prepare(
      "UPDATE pilot_applications SET status = 'pending', resource_state = 'needs_reconcile', resource_error = ?1, provisioning_started_at = NULL, updated_at = ?2 WHERE application_id = ?3 AND status = 'provisioning'",
    ).bind(safeResourceError(error), new Date().toISOString(), applicationId).run();
    console.error(JSON.stringify({ event: "device_provision_failed", applicationId, message: errorMessage(error) }));
    throw new HttpError(502, "Device connection could not be prepared; check control-plane logs and retry");
  }
}

async function adminRejectApplication(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const reason = optionalLimitedString(body.reason, "reason", 300);
  const now = new Date().toISOString();
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  if (current.status !== "pending") throw new HttpError(409, `Only a pending application can be rejected: ${current.status}`);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE pilot_applications SET status = 'rejected', rejected_at = ?1, rejection_reason = ?2, updated_at = ?1 WHERE application_id = ?3 AND status = 'pending'",
    ).bind(now, reason ?? null, applicationId),
    auditStatement(env, applicationId, "rejected", auditContext(env, now), {
      fromStatus: "pending",
      toStatus: "rejected",
      reason: reason ?? null,
    }),
  ]);
  return json({ applicationId, status: "rejected", rejectedAt: now, ...(reason ? { reason } : {}) });
}

async function adminReopenApplication(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const reason = limitedString(body.reason, "reason", 300);
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  if (current.status !== "rejected") throw new HttpError(409, `Only a rejected application can be reopened: ${current.status}`);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE pilot_applications SET status = 'pending', rejected_at = NULL, rejection_reason = NULL, updated_at = ?1 WHERE application_id = ?2 AND status = 'rejected'",
    ).bind(now, applicationId),
    auditStatement(env, applicationId, "reopened", auditContext(env, now), {
      fromStatus: "rejected",
      toStatus: "pending",
      reason,
    }),
  ]);
  return json({ applicationId, status: "pending", reopenedAt: now });
}

async function adminChangeApplicationPeriod(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const period = requiredString(body.period, "period");
  if (!PERIODS.has(period)) throw new HttpError(400, "period must be week, month, quarter or year");
  const reason = limitedString(body.reason, "reason", 300);
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  if (current.status !== "approved") throw new HttpError(409, `Only an approved, not-yet-activated application can change period: ${current.status}`);
  if (current.period === period) throw new HttpError(409, "The authorization period is unchanged");
  if (!current.account_id || !current.activation_ciphertext || !current.approved_at) {
    throw new HttpError(409, "Application does not have a replaceable activation payload");
  }
  const activation = await decryptActivation(current.activation_ciphertext, env.DASHOU_ACTIVATION_KEY);
  const expiresAt = addAuthorizationPeriod(new Date(current.approved_at), period).toISOString();
  const activationCiphertext = await encryptActivation({ ...activation, expiresAt }, env.DASHOU_ACTIVATION_KEY);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE pilot_accounts SET expires_at = ?1 WHERE account_id = ?2").bind(expiresAt, current.account_id),
    env.DB.prepare(
      "UPDATE pilot_applications SET period = ?1, expires_at = ?2, activation_ciphertext = ?3, updated_at = ?4 WHERE application_id = ?5 AND status = 'approved'",
    ).bind(period, expiresAt, activationCiphertext, now, applicationId),
    auditStatement(env, applicationId, "period_changed", auditContext(env, now), {
      fromStatus: "approved",
      toStatus: "approved",
      fromPeriod: current.period,
      toPeriod: period,
      reason,
    }),
  ]);
  return json({ applicationId, status: "approved", period, expiresAt, changedAt: now });
}

async function adminExtendApplication(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const period = requiredString(body.period, "period");
  if (!PERIODS.has(period)) throw new HttpError(400, "period must be week, month, quarter or year");
  const reason = limitedString(body.reason, "reason", 300);
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  if (current.status !== "activated") throw new HttpError(409, `Only an activated application can be extended: ${current.status}`);
  if (!current.account_id) throw new HttpError(409, "Activated application has no account");
  const currentExpiry = Date.parse(current.expires_at);
  const base = Number.isFinite(currentExpiry) ? new Date(Math.max(Date.now(), currentExpiry)) : new Date();
  const expiresAt = addAuthorizationPeriod(base, period).toISOString();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE pilot_accounts SET enabled = 1, expires_at = ?1, revoked_at = NULL WHERE account_id = ?2").bind(expiresAt, current.account_id),
    env.DB.prepare("UPDATE pilot_applications SET expires_at = ?1, updated_at = ?2 WHERE application_id = ?3 AND status = 'activated'").bind(expiresAt, now, applicationId),
    auditStatement(env, applicationId, "authorization_extended", auditContext(env, now), {
      fromStatus: "activated",
      toStatus: "activated",
      fromPeriod: current.period,
      toPeriod: period,
      reason,
    }),
  ]);
  return json({ applicationId, status: "activated", extensionPeriod: period, expiresAt, extendedAt: now });
}

async function adminAddApplicationNote(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const note = limitedString(body.note, "note", 1_000);
  const current = await env.DB.prepare("SELECT application_id FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO pilot_admin_audit_events (audit_id, application_id, actor, action, note, request_id, created_at) VALUES (?1, ?2, ?3, 'note_added', ?4, ?5, ?6)",
  ).bind(`audit_${randomToken().slice(0, 24)}`, applicationId, env.PILOT_ADMIN_ACTOR?.trim() || "admin", note, `req_${randomToken().slice(0, 24)}`, now).run();
  return json({ applicationId, noteAddedAt: now });
}

async function adminRevokeApplication(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const reason = optionalLimitedString(body.reason, "reason", 300);
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  if (!current.account_id || !["approved", "activated", "expired"].includes(current.status)) {
    throw new HttpError(409, `Application cannot be revoked from status: ${current.status}`);
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE pilot_accounts SET enabled = 0, revoked_at = COALESCE(revoked_at, ?1) WHERE account_id = ?2").bind(now, current.account_id),
    env.DB.prepare("UPDATE pilot_applications SET status = 'revoked', revoked_at = ?1, revoked_from_status = ?2, updated_at = ?1 WHERE application_id = ?3").bind(now, current.status, applicationId),
    auditStatement(env, applicationId, "revoked", auditContext(env, now), {
      fromStatus: current.status,
      toStatus: "revoked",
      reason: reason ?? null,
    }),
  ]);
  return json({ applicationId, status: "revoked", revokedAt: now, ...(reason ? { reason } : {}) });
}

async function adminRetireApplication(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const reason = limitedString(body.reason, "reason", 300);
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  if (current.deprovisioned_at || current.resource_state === "deleted") {
    throw new HttpError(409, "Application connection has already been retired");
  }
  if (!current.tunnel_id || !current.hostname || !current.account_id) {
    throw new HttpError(409, "Application does not have a complete retained connection to retire");
  }
  if (!["approved", "activated", "expired", "revoked"].includes(current.status)) {
    throw new HttpError(409, `Application connection cannot be retired from status: ${current.status}`);
  }
  const startedAt = new Date().toISOString();
  const fromStatus = current.status;
  await env.DB.batch([
    env.DB.prepare("UPDATE pilot_accounts SET enabled = 0, revoked_at = COALESCE(revoked_at, ?1) WHERE account_id = ?2").bind(startedAt, current.account_id),
    env.DB.prepare("UPDATE pilot_applications SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?1), revoked_from_status = COALESCE(revoked_from_status, ?2), resource_state = 'deleting', resource_error = NULL, updated_at = ?1 WHERE application_id = ?3").bind(startedAt, fromStatus, applicationId),
    auditStatement(env, applicationId, "retirement_started", auditContext(env, startedAt), {
      fromStatus,
      toStatus: "revoked",
      reason,
      note: "Cloudflare Tunnel and DNS retirement started",
    }),
  ]);
  const deprovisioner = typeof env.DEVICE_DEPROVISIONER === "function" ? env.DEVICE_DEPROVISIONER : deleteDeviceTunnel;
  try {
    const result = await deprovisioner(env, { tunnelId: current.tunnel_id, hostname: current.hostname });
    const completedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE pilot_applications SET resource_state = 'deleted', resource_error = NULL, deprovisioned_at = ?1, updated_at = ?1 WHERE application_id = ?2 AND resource_state = 'deleting'").bind(completedAt, applicationId),
      auditStatement(env, applicationId, "retired", auditContext(env, completedAt), {
        fromStatus: "revoked",
        toStatus: "revoked",
        reason,
        note: `Cloudflare connection retired; DNS records deleted: ${Number(result?.deletedDnsRecords ?? 0)}`,
      }),
    ]);
    return json({ applicationId, status: "revoked", resourceState: "deleted", retiredAt: completedAt });
  } catch (error) {
    const failedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE pilot_applications SET resource_state = 'delete_failed', resource_error = ?1, updated_at = ?2 WHERE application_id = ?3 AND resource_state = 'deleting'").bind(safeResourceError(error), failedAt, applicationId),
      auditStatement(env, applicationId, "retirement_failed", auditContext(env, failedAt), {
        fromStatus: "revoked",
        toStatus: "revoked",
        reason,
        note: "Cloudflare connection retirement requires reconciliation",
      }),
    ]);
    throw new HttpError(502, "账号已停用，但 Cloudflare 连接清理暂未完成。系统已保留记录，请稍后重试“释放专属连接”");
  }
}

async function adminRestoreApplication(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const reason = limitedString(body.reason, "reason", 300);
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  if (current.status !== "revoked") throw new HttpError(409, `Only a revoked application can be restored: ${current.status}`);
  if (current.deprovisioned_at || current.resource_state === "deleted") {
    throw new HttpError(409, "The Cloudflare connection was physically retired; reopen or submit a replacement application instead");
  }
  if (["deleting", "delete_failed", "needs_reconcile"].includes(current.resource_state)) {
    throw new HttpError(409, `Application connection must be reconciled before restore: ${current.resource_state}`);
  }
  const restoredStatus = current.revoked_from_status || (current.activated_at ? "activated" : "approved");
  if (!["approved", "activated", "expired"].includes(restoredStatus)) {
    throw new HttpError(409, `Revoked application has no restorable status: ${restoredStatus}`);
  }
  if (restoredStatus === "approved" && !current.activation_ciphertext) {
    throw new HttpError(409, "The previous pending authorization payload is no longer available; submit a new application");
  }
  if (!current.account_id) throw new HttpError(409, "Revoked application has no pilot account");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE pilot_accounts SET enabled = 1, revoked_at = NULL WHERE account_id = ?1").bind(current.account_id),
    env.DB.prepare("UPDATE pilot_applications SET status = ?1, revoked_at = NULL, revoked_from_status = NULL, updated_at = ?2 WHERE application_id = ?3 AND status = 'revoked'").bind(restoredStatus, now, applicationId),
    auditStatement(env, applicationId, "restored", auditContext(env, now), {
      fromStatus: "revoked",
      toStatus: restoredStatus,
      reason,
    }),
  ]);
  return json({ applicationId, status: restoredStatus, restoredAt: now });
}

async function adminEditAuthorization(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const expiresAt = requiredString(body.expiresAt, "expiresAt");
  validateExpiry(expiresAt);
  const reason = limitedString(body.reason, "reason", 300);
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  if (!["approved", "activated", "expired", "revoked"].includes(current.status)) {
    throw new HttpError(409, `Application cannot edit authorization from status: ${current.status}`);
  }
  if (current.expires_at === expiresAt) throw new HttpError(409, "The authorization date is unchanged");
  let activationCiphertext = current.activation_ciphertext;
  if (current.status === "approved") {
    if (!current.activation_ciphertext) throw new HttpError(409, "Application does not have a replaceable activation payload");
    const activation = await decryptActivation(current.activation_ciphertext, env.DASHOU_ACTIVATION_KEY);
    activationCiphertext = await encryptActivation({ ...activation, expiresAt }, env.DASHOU_ACTIVATION_KEY);
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    ...(current.account_id ? [env.DB.prepare("UPDATE pilot_accounts SET expires_at = ?1 WHERE account_id = ?2").bind(expiresAt, current.account_id)] : []),
    env.DB.prepare("UPDATE pilot_applications SET period = NULL, expires_at = ?1, activation_ciphertext = ?2, updated_at = ?3 WHERE application_id = ?4").bind(expiresAt, activationCiphertext, now, applicationId),
    auditStatement(env, applicationId, "authorization_changed", auditContext(env, now), {
      fromStatus: current.status,
      toStatus: current.status,
      reason,
      note: `expiresAt: ${current.expires_at || "—"} → ${expiresAt}`,
    }),
  ]);
  return json({ applicationId, status: current.status, expiresAt, changedAt: now });
}

async function adminEditApplicationProfile(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const hasNickname = Object.prototype.hasOwnProperty.call(body, "nickname");
  const hasProfileNote = Object.prototype.hasOwnProperty.call(body, "profileNote");
  if (!hasNickname && !hasProfileNote) throw new HttpError(400, "nickname or profileNote is required");
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  const nickname = hasNickname ? (optionalLimitedString(body.nickname, "nickname", 100) ?? null) : (current.nickname ?? null);
  const profileNote = hasProfileNote ? (optionalLimitedString(body.profileNote, "profileNote", 1_000) ?? null) : (current.profile_note ?? null);
  if (nickname === (current.nickname ?? null) && profileNote === (current.profile_note ?? null)) {
    throw new HttpError(409, "The application profile is unchanged");
  }
  const now = new Date().toISOString();
  const changes = [
    hasNickname ? `昵称：${current.nickname || "未设置"} → ${nickname || "未设置"}` : null,
    hasProfileNote ? "基本信息备注已更新" : null,
  ].filter(Boolean).join("；");
  await env.DB.batch([
    env.DB.prepare("UPDATE pilot_applications SET nickname = ?1, profile_note = ?2, updated_at = ?3 WHERE application_id = ?4").bind(nickname, profileNote, now, applicationId),
    auditStatement(env, applicationId, "profile_updated", auditContext(env, now), {
      fromStatus: current.status,
      toStatus: current.status,
      note: changes,
    }),
  ]);
  return json({ applicationId, nickname, profileNote, updatedAt: now });
}

async function adminSetApplicationSubject(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const subjectId = normalizedSubjectId(body.subjectId);
  const reason = limitedString(body.reason, "reason", 300);
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  if (current.subject_id === subjectId) throw new HttpError(409, "The customer identity is unchanged");
  if (["provisioning", "deleting"].includes(current.resource_state)) {
    throw new HttpError(409, `Customer identity cannot change while resource state is ${current.resource_state}`);
  }
  if (RESOURCE_SLOT_STATES.has(current.resource_state)) {
    const occupied = await env.DB.prepare(
      "SELECT application_id, resource_state FROM pilot_applications WHERE subject_id = ?1 AND application_id <> ?2 AND resource_state IN ('provisioning', 'active', 'needs_reconcile', 'deleting', 'delete_failed') LIMIT 1",
    ).bind(subjectId, applicationId).first();
    if (occupied) throw new HttpError(409, `Customer ${subjectId} already owns retained connection ${occupied.application_id}`);
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE pilot_applications SET subject_id = ?1, updated_at = ?2 WHERE application_id = ?3").bind(subjectId, now, applicationId),
    auditStatement(env, applicationId, "subject_changed", auditContext(env, now), {
      fromStatus: current.status,
      toStatus: current.status,
      reason,
      note: `customer: ${current.subject_id || "unassigned"} -> ${subjectId}`,
    }),
  ]);
  return json({ applicationId, subjectId, changedAt: now });
}

async function authorizedApplication(request, env, applicationId) {
  validateApplicationId(applicationId);
  const token = bearerToken(request);
  if (!token || !APPLICATION_TOKEN_PATTERN.test(token)) throw new HttpError(401, "Invalid application credential");
  const tokenHash = await sha256Base64Url(token);
  const row = await env.DB.prepare(
    "SELECT * FROM pilot_applications WHERE application_id = ?1 AND application_token_hash = ?2",
  ).bind(applicationId, tokenHash).first();
  if (!row) throw new HttpError(401, "Invalid application credential");
  if (["approved", "activated"].includes(row.status) && row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE pilot_applications SET status = 'expired', activation_ciphertext = NULL, updated_at = ?1 WHERE application_id = ?2 AND status IN ('approved', 'activated')",
    ).bind(now, applicationId).run();
    row.status = "expired";
    row.activation_ciphertext = null;
    row.updated_at = now;
  }
  return row;
}

function applicationStatusSummary(row) {
  return {
    applicationId: row.application_id,
    status: row.status,
    createdAt: row.created_at,
    ...(row.period ? { period: row.period } : {}),
    ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.hostname ? { mcpUrl: `https://${row.hostname}/mcp` } : {}),
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
    ...(row.rejected_at ? { rejectedAt: row.rejected_at } : {}),
    ...(row.rejection_reason ? { reason: row.rejection_reason } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function adminApplicationSummary(row, allRows = []) {
  const related = relatedApplicationSummaries(row, allRows);
  return {
    ...applicationStatusSummary(row),
    deviceId: row.device_id,
    deviceName: row.device_name,
    ...(row.device_nickname ? { deviceNickname: row.device_nickname } : {}),
    ...(row.device_fingerprint ? { deviceFingerprint: row.device_fingerprint } : {}),
    ...(row.nickname ? { nickname: row.nickname } : {}),
    ...(row.profile_note ? { profileNote: row.profile_note } : {}),
    platform: row.platform,
    ...(row.contact ? { contact: row.contact } : {}),
    ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    ...(row.resource_state ? { resourceState: row.resource_state } : {}),
    ...(row.resource_error ? { resourceError: row.resource_error } : {}),
    ...(row.deprovisioned_at ? { deprovisionedAt: row.deprovisioned_at } : {}),
    duplicateRisk: related.length > 0,
    relatedApplicationIds: related.map((application) => application.applicationId),
    ...(row.provisioning_started_at ? { provisioningStartedAt: row.provisioning_started_at } : {}),
    ...(row.activation_started_at ? { activationStartedAt: row.activation_started_at } : {}),
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

function relatedApplicationSummaries(row, allRows) {
  const contact = row.contact?.trim().toLowerCase();
  return allRows
    .filter((candidate) => candidate.application_id !== row.application_id)
    .map((candidate) => {
      const signals = [];
      if (row.subject_id && candidate.subject_id === row.subject_id) signals.push("same_customer");
      if (row.device_fingerprint && candidate.device_fingerprint === row.device_fingerprint) signals.push("same_fingerprint");
      if (contact && candidate.contact?.trim().toLowerCase() === contact) signals.push("same_contact");
      return signals.length ? { candidate, signals } : null;
    })
    .filter(Boolean)
    .map(({ candidate, signals }) => ({
      applicationId: candidate.application_id,
      status: candidate.status,
      deviceName: candidate.device_name,
      ...(candidate.subject_id ? { subjectId: candidate.subject_id } : {}),
      ...(candidate.resource_state ? { resourceState: candidate.resource_state } : {}),
      signals,
    }));
}

async function retainedResourceCount(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM pilot_applications WHERE resource_state IN ('provisioning', 'active', 'needs_reconcile', 'deleting', 'delete_failed')",
  ).first();
  return Number(row?.count ?? 0);
}

function maxActiveResources(value) {
  if (value === undefined || value === "") return DEFAULT_MAX_ACTIVE_RESOURCES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error("DASHOU_MAX_ACTIVE_RESOURCES must be an integer between 1 and 10000");
  }
  return parsed;
}

function resourcePolicySummary(env) {
  return {
    version: 1,
    enforced: true,
    requiresSubjectId: true,
    maxRetainedResources: maxActiveResources(env.DASHOU_MAX_ACTIVE_RESOURCES),
  };
}

function normalizedSubjectId(value) {
  const subjectId = requiredString(value, "subjectId").toLowerCase();
  if (!SUBJECT_ID_PATTERN.test(subjectId)) {
    throw new HttpError(400, "subjectId must be 3-64 lowercase characters using letters, numbers, dot, underscore or hyphen");
  }
  return subjectId;
}

function safeResourceError(error) {
  const message = errorMessage(error).replace(/[^A-Za-z0-9 _.:/-]/g, "").slice(0, 160);
  return message || "provider error";
}

async function pilotPolicy(request, env) {
  const token = bearerToken(request);
  if (!token) return json({ error: "Invalid pilot account token" }, 401);
  const tokenHash = await sha256Base64Url(token);
  const row = await env.DB.prepare(
    "SELECT account_id, enabled, expires_at, revoked_at FROM pilot_accounts WHERE token_hash = ?1",
  ).bind(tokenHash).first();
  if (!row || row.revoked_at) return json({ error: "Invalid pilot account token" }, 401);
  const issuedAt = new Date().toISOString();
  const enabled = row.enabled === 1 && Date.parse(row.expires_at) > Date.now();
  const leaseTtlSeconds = leaseTtl(env.PILOT_LEASE_TTL_SECONDS);
  const accountExpiry = Date.parse(row.expires_at);
  const leaseExpiry = enabled
    ? Math.min(accountExpiry, Date.now() + leaseTtlSeconds * 1_000)
    : Date.now() + leaseTtlSeconds * 1_000;
  const payload = { accountId: row.account_id, enabled, expiresAt: new Date(leaseExpiry).toISOString(), issuedAt };
  if (!env.PILOT_LEASE_PRIVATE_KEY) return json({ error: "Pilot lease signer is not configured" }, 503);
  return json({ lease: await signLease(payload, env.PILOT_LEASE_PRIVATE_KEY) });
}

async function adminList(request, env) {
  requireAdmin(request, env);
  const result = await env.DB.prepare(
    "SELECT account_id, enabled, expires_at, created_at, revoked_at FROM pilot_accounts ORDER BY account_id",
  ).all();
  return json({ accounts: (result.results ?? []).map(accountSummary) });
}

async function adminCreate(request, env) {
  requireAdmin(request, env);
  const body = await jsonObject(request);
  const accountId = requiredString(body.accountId, "accountId");
  validateAccountId(accountId);
  const expiresAt = requiredString(body.expiresAt, "expiresAt");
  validateExpiry(expiresAt);
  const enabled = body.enabled === undefined ? true : requiredBoolean(body.enabled, "enabled");
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO pilot_accounts (account_id, token_hash, enabled, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).bind(accountId, await sha256Base64Url(token), enabled ? 1 : 0, expiresAt, new Date().toISOString()).run();
  return json({ accountId, token, enabled, expiresAt }, 201);
}

async function adminUpdate(request, env, accountId) {
  requireAdmin(request, env);
  validateAccountId(accountId);
  const body = await jsonObject(request);
  const current = await env.DB.prepare(
    "SELECT account_id, enabled, expires_at, created_at, revoked_at FROM pilot_accounts WHERE account_id = ?1",
  ).bind(accountId).first();
  if (!current) throw new HttpError(404, `Pilot account not found: ${accountId}`);
  if (current.revoked_at && (body.revoke !== true || body.enabled !== undefined || body.expiresAt !== undefined)) {
    throw new HttpError(409, `Pilot account is revoked: ${accountId}`);
  }
  let enabled = current.enabled === 1;
  let expiresAt = current.expires_at;
  let revokedAt = current.revoked_at;
  if (body.revoke === true) {
    enabled = false;
    revokedAt ??= new Date().toISOString();
  }
  if (body.enabled !== undefined) enabled = requiredBoolean(body.enabled, "enabled");
  if (body.expiresAt !== undefined) {
    expiresAt = requiredString(body.expiresAt, "expiresAt");
    validateExpiry(expiresAt);
  }
  await env.DB.prepare(
    "UPDATE pilot_accounts SET enabled = ?1, expires_at = ?2, revoked_at = ?3 WHERE account_id = ?4",
  ).bind(enabled ? 1 : 0, expiresAt, revokedAt, accountId).run();
  return json({ accountId, enabled, expiresAt, createdAt: current.created_at, ...(revokedAt ? { revokedAt } : {}) });
}

function requireAdmin(request, env) {
  if (!adminAuthorized(request, env)) throw new HttpError(401, "Invalid pilot admin token");
}

function auditContext(env, createdAt = new Date().toISOString()) {
  return {
    actor: env.PILOT_ADMIN_ACTOR?.trim() || "admin",
    requestId: `req_${randomToken().slice(0, 24)}`,
    createdAt,
  };
}

function auditStatement(env, applicationId, action, context, fields = {}) {
  return env.DB.prepare(
    "INSERT INTO pilot_admin_audit_events (audit_id, application_id, actor, action, from_status, to_status, from_period, to_period, reason, note, request_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
  ).bind(
    `audit_${randomToken().slice(0, 24)}`,
    applicationId,
    context.actor,
    action,
    fields.fromStatus ?? null,
    fields.toStatus ?? null,
    fields.fromPeriod ?? null,
    fields.toPeriod ?? null,
    fields.reason ?? null,
    fields.note ?? null,
    context.requestId,
    context.createdAt,
  );
}

function adminAuthorized(request, env) {
  const presented = bearerToken(request);
  return Boolean(presented && env.PILOT_ADMIN_TOKEN && constantTimeEqual(presented, env.PILOT_ADMIN_TOKEN));
}

function bearerToken(request) {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || undefined;
}

function accountSummary(row) {
  return {
    accountId: row.account_id,
    enabled: row.enabled === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.revoked_from_status ? { revokedFromStatus: row.revoked_from_status } : {}),
  };
}

async function jsonObject(request) {
  let value;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "JSON body must be an object");
  return value;
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${field} is required`);
  return value.trim();
}

function limitedString(value, field, maxLength) {
  const text = requiredString(value, field);
  if (text.length > maxLength) throw new HttpError(400, `${field} must be at most ${maxLength} characters`);
  return text;
}

function optionalLimitedString(value, field, maxLength) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new HttpError(400, `${field} must be at most ${maxLength} characters`);
  return text;
}

const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function limitedDisplayString(value, field, maxLength) {
  const text = limitedString(value, field, maxLength);
  if (UNSAFE_DISPLAY_CHARACTERS.test(text)) throw new HttpError(400, `${field} contains unsupported control characters`);
  return text;
}

function optionalLimitedDisplayString(value, field, maxLength) {
  const text = optionalLimitedString(value, field, maxLength);
  if (text && UNSAFE_DISPLAY_CHARACTERS.test(text)) throw new HttpError(400, `${field} contains unsupported control characters`);
  return text;
}

function requiredBoolean(value, field) {
  if (typeof value !== "boolean") throw new HttpError(400, `${field} must be a boolean`);
  return value;
}

function validateAccountId(value) {
  if (!ACCOUNT_ID_PATTERN.test(value)) throw new HttpError(400, "accountId must be 2-64 characters using letters, numbers, dot, underscore or hyphen");
}

function validateApplicationId(value) {
  if (!APPLICATION_ID_PATTERN.test(value)) throw new HttpError(400, "Invalid applicationId");
}

function validateExpiry(value) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, "expiresAt must be an ISO-8601 date-time");
  }
}

function leaseTtl(value) {
  if (value === undefined || value === "") return DEFAULT_LEASE_TTL_SECONDS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 60 || parsed > 24 * 60 * 60) {
    throw new Error("PILOT_LEASE_TTL_SECONDS must be an integer between 60 and 86400");
  }
  return parsed;
}

function addAuthorizationPeriod(now, period) {
  if (period === "week") return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const months = period === "month" ? 1 : period === "quarter" ? 3 : 12;
  const result = new Date(now.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

async function encryptActivation(payload, encodedKey) {
  const key = await activationKey(encodedKey, ["encrypt"]);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptActivation(value, encodedKey) {
  const [version, encodedIv, encodedCiphertext] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext) throw new Error("Stored activation payload is invalid");
  const key = await activationKey(encodedKey, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(encodedIv) },
    key,
    decodeBase64Url(encodedCiphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function activationKey(value, usages) {
  const encoded = requiredString(value, "DASHOU_ACTIVATION_KEY");
  const bytes = decodeBase64Url(encoded);
  if (bytes.byteLength !== 32) throw new Error("DASHOU_ACTIVATION_KEY must be a base64url-encoded 32-byte key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);
}

async function activationReceipt(applicationId, tokenHash, encodedKey) {
  const key = decodeBase64Url(requiredString(encodedKey, "DASHOU_ACTIVATION_KEY"));
  if (key.byteLength !== 32) throw new Error("DASHOU_ACTIVATION_KEY must be a base64url-encoded 32-byte key");
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(`${applicationId}.${tokenHash}`));
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signLease(payload, privateKeyPem) {
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem, "PRIVATE KEY"),
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    new TextEncoder().encode(encodedPayload),
  );
  return `${encodedPayload}.${base64Url(new Uint8Array(signature))}`;
}

function pemToArrayBuffer(pem, label) {
  const normalized = pem.trim().replaceAll("\\n", "\n");
  const body = normalized
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function controlPublicUrl(request, env) {
  const value = env.DASHOU_CONTROL_PUBLIC_URL?.trim() || new URL(request.url).origin;
  const url = new URL(value);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("DASHOU_CONTROL_PUBLIC_URL must use https outside localhost");
  }
  return url;
}

function normalizeHttpsBaseUrl(value) {
  const url = new URL(requiredString(value, "publicBaseUrl"));
  if (url.protocol !== "https:") throw new Error("Provisioned publicBaseUrl must use https");
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function changed(result) {
  const changes = result?.meta?.changes ?? result?.changes;
  return changes === undefined ? true : changes > 0;
}

function constantTimeEqual(leftValue, rightValue) {
  const left = new TextEncoder().encode(leftValue);
  const right = new TextEncoder().encode(rightValue);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function errorStatus(error) {
  return error instanceof HttpError ? error.status : 500;
}

function publicErrorMessage(error) {
  return error instanceof HttpError ? error.message : "Internal server error";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
