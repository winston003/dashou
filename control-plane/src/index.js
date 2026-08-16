import { provisionDeviceTunnel } from "./cloudflare.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const APPLICATION_ID_PATTERN = /^req_[A-Za-z0-9_-]{16,64}$/;
const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{16,96}$/;
const APPLICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const PERIODS = new Set(["week", "month", "quarter", "year"]);
const CONTROL_PLANE_VERSION = "0.1.3-rc.2";
const DEFAULT_LEASE_TTL_SECONDS = 15 * 60;

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
    return json({ ok: true, name: "dashou-pilot-control", version: CONTROL_PLANE_VERSION, buildSha: env.DASHOU_BUILD_SHA ?? "dev" });
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

  if (url.pathname === "/admin/applications" && request.method === "GET") return adminApplicationList(request, env, url);
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
  const revokeMatch = /^\/admin\/applications\/([^/]+)\/revoke$/.exec(url.pathname);
  if (revokeMatch && request.method === "POST") {
    return adminRevokeApplication(request, env, decodeURIComponent(revokeMatch[1]));
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
  const deviceName = limitedString(body.deviceName, "deviceName", 100);
  const platform = limitedString(body.platform, "platform", 40);
  const contact = optionalLimitedString(body.contact, "contact", 200);
  const tokenHash = await sha256Base64Url(applicationToken);

  const existing = await env.DB.prepare(
    "SELECT application_id, application_token_hash, status, created_at FROM pilot_applications WHERE device_id = ?1 AND status IN ('pending', 'provisioning', 'approved', 'activated')",
  ).bind(deviceId).first();
  if (existing) {
    if (!constantTimeEqual(existing.application_token_hash, tokenHash)) {
      throw new HttpError(409, "This device already has an active application");
    }
    return json({ applicationId: existing.application_id, status: existing.status, createdAt: existing.created_at });
  }

  await enforceApplicationRateLimit(request, env);

  const applicationId = `req_${randomToken().slice(0, 22)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO pilot_applications (application_id, application_token_hash, device_id, device_name, platform, contact, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)",
  ).bind(applicationId, tokenHash, deviceId, deviceName, platform, contact ?? null, now).run();
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
  const statement = status
    ? env.DB.prepare("SELECT * FROM pilot_applications WHERE status = ?1 ORDER BY created_at").bind(status)
    : env.DB.prepare("SELECT * FROM pilot_applications ORDER BY created_at");
  const result = await statement.all();
  return json({ applications: (result.results ?? []).map(adminApplicationSummary) });
}

async function adminApplicationDetail(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const row = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!row) throw new HttpError(404, `Application not found: ${applicationId}`);
  return json({ application: adminApplicationSummary(row) });
}

async function adminApproveApplication(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const body = await jsonObject(request);
  const period = requiredString(body.period, "period");
  if (!PERIODS.has(period)) throw new HttpError(400, "period must be week, month, quarter or year");
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  const recovering = current.status === "provisioning"
    && Number.isFinite(Date.parse(current.provisioning_started_at))
    && Date.parse(current.provisioning_started_at) < Date.now() - 5 * 60 * 1_000;
  if (current.status !== "pending" && !recovering) {
    throw new HttpError(409, `Application cannot be approved from status: ${current.status}`);
  }

  const provisioningStartedAt = new Date().toISOString();
  const claim = recovering
    ? await env.DB.prepare(
      "UPDATE pilot_applications SET provisioning_started_at = ?1, updated_at = ?1 WHERE application_id = ?2 AND status = 'provisioning' AND provisioning_started_at = ?3",
    ).bind(provisioningStartedAt, applicationId, current.provisioning_started_at).run()
    : await env.DB.prepare(
      "UPDATE pilot_applications SET status = 'provisioning', provisioning_started_at = ?1, updated_at = ?1 WHERE application_id = ?2 AND status = 'pending'",
    ).bind(provisioningStartedAt, applicationId).run();
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
        "UPDATE pilot_applications SET status = 'approved', period = ?1, account_id = ?2, tunnel_id = ?3, hostname = ?4, activation_ciphertext = ?5, approved_at = ?6, expires_at = ?7, updated_at = ?6 WHERE application_id = ?8 AND status = 'provisioning'",
      ).bind(period, accountId, requiredString(provisioned.tunnelId, "provisioned tunnelId"), requiredString(provisioned.hostname, "provisioned hostname"), activationCiphertext, approvedAtText, expiresAt, applicationId),
    ];
    if (typeof env.DB.batch !== "function") throw new Error("D1 batch support is required");
    await env.DB.batch(statements);
    return json({ applicationId, status: "approved", period, approvedAt: approvedAtText, expiresAt, mcpUrl: new URL("/mcp", publicBaseUrl).toString() });
  } catch (error) {
    await env.DB.prepare(
      "UPDATE pilot_applications SET status = 'pending', provisioning_started_at = NULL, updated_at = ?1 WHERE application_id = ?2 AND status = 'provisioning'",
    ).bind(new Date().toISOString(), applicationId).run();
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
  const result = await env.DB.prepare(
    "UPDATE pilot_applications SET status = 'rejected', rejected_at = ?1, rejection_reason = ?2, updated_at = ?1 WHERE application_id = ?3 AND status = 'pending'",
  ).bind(now, reason ?? null, applicationId).run();
  if (!changed(result)) throw new HttpError(409, "Only a pending application can be rejected");
  return json({ applicationId, status: "rejected", rejectedAt: now, ...(reason ? { reason } : {}) });
}

async function adminRevokeApplication(request, env, applicationId) {
  requireAdmin(request, env);
  validateApplicationId(applicationId);
  const current = await env.DB.prepare("SELECT * FROM pilot_applications WHERE application_id = ?1").bind(applicationId).first();
  if (!current) throw new HttpError(404, `Application not found: ${applicationId}`);
  if (!current.account_id || !["approved", "activated", "expired"].includes(current.status)) {
    throw new HttpError(409, `Application cannot be revoked from status: ${current.status}`);
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE pilot_accounts SET enabled = 0, revoked_at = COALESCE(revoked_at, ?1) WHERE account_id = ?2").bind(now, current.account_id),
    env.DB.prepare("UPDATE pilot_applications SET status = 'revoked', revoked_at = ?1, activation_ciphertext = NULL, updated_at = ?1 WHERE application_id = ?2").bind(now, applicationId),
  ]);
  return json({ applicationId, status: "revoked", revokedAt: now });
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

function adminApplicationSummary(row) {
  return {
    ...applicationStatusSummary(row),
    deviceId: row.device_id,
    deviceName: row.device_name,
    platform: row.platform,
    ...(row.contact ? { contact: row.contact } : {}),
    ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.provisioning_started_at ? { provisioningStartedAt: row.provisioning_started_at } : {}),
    ...(row.activation_started_at ? { activationStartedAt: row.activation_started_at } : {}),
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
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
