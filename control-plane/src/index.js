const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const CONTROL_PLANE_VERSION = "0.1.2-rc2";
const DEFAULT_LEASE_TTL_SECONDS = 15 * 60;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(JSON.stringify({ event: "pilot_control_error", message: errorMessage(error) }));
      return json({ error: "Internal server error" }, 500);
    }
  },
};

export async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({ ok: true, name: "dashou-pilot-control", version: CONTROL_PLANE_VERSION, buildSha: env.DASHOU_BUILD_SHA ?? "dev" });
  }
  if (request.method === "GET" && url.pathname === "/pilot-policy") {
    return pilotPolicy(request, env);
  }
  if (url.pathname === "/admin/pilot/accounts" && request.method === "GET") {
    return adminList(request, env);
  }
  if (url.pathname === "/admin/pilot/accounts" && request.method === "POST") {
    return adminCreate(request, env);
  }
  const accountMatch = /^\/admin\/pilot\/accounts\/([^/]+)$/.exec(url.pathname);
  if (accountMatch && request.method === "POST") {
    return adminUpdate(request, env, decodeURIComponent(accountMatch[1]));
  }
  return json({ error: "Not found" }, 404);
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
  const payload = {
    accountId: row.account_id,
    enabled,
    expiresAt: new Date(leaseExpiry).toISOString(),
    issuedAt,
  };
  if (!env.PILOT_LEASE_PRIVATE_KEY) return json({ error: "Pilot lease signer is not configured" }, 503);
  return json({
    lease: await signLease(payload, env.PILOT_LEASE_PRIVATE_KEY),
  });
}

async function adminList(request, env) {
  if (!adminAuthorized(request, env)) return json({ error: "Invalid pilot admin token" }, 401);
  const result = await env.DB.prepare(
    "SELECT account_id, enabled, expires_at, created_at, revoked_at FROM pilot_accounts ORDER BY account_id",
  ).all();
  return json({ accounts: (result.results ?? []).map(accountSummary) });
}

async function adminCreate(request, env) {
  if (!adminAuthorized(request, env)) return json({ error: "Invalid pilot admin token" }, 401);
  try {
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
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
}

async function adminUpdate(request, env, accountId) {
  if (!adminAuthorized(request, env)) return json({ error: "Invalid pilot admin token" }, 401);
  try {
    validateAccountId(accountId);
    const body = await jsonObject(request);
    const current = await env.DB.prepare(
      "SELECT account_id, enabled, expires_at, created_at, revoked_at FROM pilot_accounts WHERE account_id = ?1",
    ).bind(accountId).first();
    if (!current) throw new Error(`Pilot account not found: ${accountId}`);
    if (current.revoked_at && (body.revoke !== true || body.enabled !== undefined || body.expiresAt !== undefined)) {
      throw new Error(`Pilot account is revoked: ${accountId}`);
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
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
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
  const value = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
  return value;
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function requiredBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function validateAccountId(value) {
  if (!ACCOUNT_ID_PATTERN.test(value)) throw new Error("accountId must be 2-64 characters using letters, numbers, dot, underscore or hyphen");
}

function validateExpiry(value) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("expiresAt must be an ISO-8601 date-time");
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

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
