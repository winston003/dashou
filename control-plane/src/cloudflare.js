const API_ROOT = "https://api.cloudflare.com/client/v4";
const TUNNEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function provisionDeviceTunnel(env, application) {
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  const zoneId = required(env.CLOUDFLARE_ZONE_ID, "CLOUDFLARE_ZONE_ID");
  const apiToken = required(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
  const publicDomain = normalizeDomain(required(env.DASHOU_PUBLIC_DOMAIN, "DASHOU_PUBLIC_DOMAIN"));
  const hostname = `${deviceHostname(application.applicationId)}.${publicDomain}`;
  const tunnelName = `dashou-${application.applicationId.replace(/[^A-Za-z0-9-]/g, "-")}`;
  const headers = { authorization: `Bearer ${apiToken}`, "content-type": "application/json" };

  const existingTunnels = await cloudflare(
    `${API_ROOT}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`,
    { headers },
  );
  let tunnel = Array.isArray(existingTunnels) ? existingTunnels.find((candidate) => candidate?.name === tunnelName) : undefined;
  if (!tunnel) {
    tunnel = await cloudflare(`${API_ROOT}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: tunnelName, config_src: "cloudflare" }),
    });
  }
  const tunnelId = required(tunnel?.id, "Cloudflare tunnel id");

  await cloudflare(
    `${API_ROOT}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname, service: "http://127.0.0.1:7677" },
            { service: "http_status:404" },
          ],
        },
      }),
    },
  );

  const records = await cloudflare(
    `${API_ROOT}/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    { headers },
  );
  const expectedTarget = `${tunnelId}.cfargotunnel.com`;
  const existingRecord = Array.isArray(records) ? records[0] : undefined;
  if (existingRecord) {
    if (String(existingRecord.content).toLowerCase() !== expectedTarget.toLowerCase()) {
      throw new Error(`Cloudflare DNS record already exists with a different target: ${hostname}`);
    }
    if (existingRecord.proxied !== true) {
      await cloudflare(`${API_ROOT}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existingRecord.id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ proxied: true }),
      });
    }
  } else {
    await cloudflare(`${API_ROOT}/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "CNAME",
        name: hostname,
        content: expectedTarget,
        proxied: true,
        ttl: 1,
        comment: `Dashou device ${application.applicationId}`,
      }),
    });
  }

  const tokenResult = await cloudflare(
    `${API_ROOT}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
    { headers },
  );
  const tunnelToken = typeof tokenResult === "string" ? tokenResult : tokenResult?.token;
  return {
    tunnelId,
    tunnelToken: required(tunnelToken, "Cloudflare tunnel token"),
    hostname,
    publicBaseUrl: `https://${hostname}`,
  };
}

export async function deleteDeviceTunnel(env, device) {
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  const zoneId = required(env.CLOUDFLARE_ZONE_ID, "CLOUDFLARE_ZONE_ID");
  const apiToken = required(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
  const publicDomain = normalizeDomain(required(env.DASHOU_PUBLIC_DOMAIN, "DASHOU_PUBLIC_DOMAIN"));
  const tunnelId = required(device.tunnelId, "device tunnel id");
  const hostname = required(device.hostname, "device hostname").toLowerCase();
  if (!TUNNEL_ID_PATTERN.test(tunnelId)) throw new Error("device tunnel id must be a Cloudflare UUID");
  if (!hostname.endsWith(`.${publicDomain}`) || hostname === publicDomain) {
    throw new Error("device hostname is outside DASHOU_PUBLIC_DOMAIN");
  }
  const headers = { authorization: `Bearer ${apiToken}`, "content-type": "application/json" };

  const records = await cloudflare(
    `${API_ROOT}/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    { headers },
  );
  const expectedTarget = `${tunnelId}.cfargotunnel.com`;
  const matchingRecords = Array.isArray(records)
    ? records.filter((record) => String(record?.name).toLowerCase() === hostname
      && String(record?.content).toLowerCase() === expectedTarget)
    : [];
  for (const record of matchingRecords) {
    await cloudflare(
      `${API_ROOT}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(required(record.id, "Cloudflare DNS record id"))}`,
      { method: "DELETE", headers },
      { notFoundIsSuccess: true },
    );
  }

  await cloudflare(
    `${API_ROOT}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
    { method: "DELETE", headers },
    { notFoundIsSuccess: true },
  );
  return { tunnelId, hostname, deletedDnsRecords: matchingRecords.length };
}

async function cloudflare(url, init, options = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  let payload;
  try {
    payload = await response.json();
  } catch {
    if (options.notFoundIsSuccess && response.status === 404) return null;
    throw new Error(`Cloudflare API returned HTTP ${response.status} with an invalid JSON response`);
  }
  if (options.notFoundIsSuccess && response.status === 404) return null;
  if (!response.ok || payload?.success !== true) {
    const messages = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => error?.message || error?.code).filter(Boolean).join("; ")
      : "unknown error";
    throw new Error(`Cloudflare API returned HTTP ${response.status}: ${messages}`);
  }
  return payload.result;
}

function deviceHostname(applicationId) {
  const suffix = applicationId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-20);
  if (suffix.length < 8) throw new Error("applicationId cannot produce a safe device hostname");
  return `device-${suffix}`;
}

function normalizeDomain(value) {
  const domain = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error("DASHOU_PUBLIC_DOMAIN must be a valid DNS domain");
  }
  return domain;
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}
