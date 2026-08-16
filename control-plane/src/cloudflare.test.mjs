import assert from "node:assert/strict";
import test from "node:test";
import { deleteDeviceTunnel, provisionDeviceTunnel } from "./cloudflare.js";

test("Cloudflare provisioner creates a remote-managed tunnel, ingress and DNS record", async (context) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/cfd_tunnel?")) return response([]);
    if (String(url).endsWith("/cfd_tunnel") && init.method === "POST") {
      return response({ id: "tunnel-123", name: "dashou-req-abcdefghijklmnop" });
    }
    if (String(url).endsWith("/configurations")) return response({});
    if (String(url).includes("/dns_records?")) return response([]);
    if (String(url).endsWith("/dns_records") && init.method === "POST") return response({ id: "dns-123" });
    if (String(url).endsWith("/token")) return response("ey.test-tunnel-token");
    throw new Error(`Unexpected Cloudflare request: ${url}`);
  };

  const result = await provisionDeviceTunnel({
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_ZONE_ID: "zone-123",
    CLOUDFLARE_API_TOKEN: "cloudflare-api-secret",
    DASHOU_PUBLIC_DOMAIN: "warmbyte.studio",
  }, { applicationId: "req_abcdefghijklmnop", deviceId: "dev_abcdefghijklmnop" });

  assert.deepEqual(result, {
    tunnelId: "tunnel-123",
    tunnelToken: "ey.test-tunnel-token",
    hostname: "device-reqabcdefghijklmnop.warmbyte.studio",
    publicBaseUrl: "https://device-reqabcdefghijklmnop.warmbyte.studio",
  });
  assert.equal(calls.length, 6);
  assert.equal(calls.every((call) => call.init.headers.authorization === "Bearer cloudflare-api-secret"), true);
  const configuration = JSON.parse(calls.find((call) => call.url.endsWith("/configurations")).init.body);
  assert.deepEqual(configuration.config.ingress, [
    { hostname: result.hostname, service: "http://127.0.0.1:7677" },
    { service: "http_status:404" },
  ]);
  const dns = JSON.parse(calls.find((call) => call.url.endsWith("/dns_records") && call.init.method === "POST").init.body);
  assert.equal(dns.content, "tunnel-123.cfargotunnel.com");
  assert.equal(dns.proxied, true);
});

test("Cloudflare provisioner reuses matching tunnel and DNS resources", async (context) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/cfd_tunnel?")) return response([{ id: "tunnel-existing", name: "dashou-req-abcdefghijklmnop" }]);
    if (String(url).endsWith("/configurations")) return response({});
    if (String(url).includes("/dns_records?")) {
      return response([{ id: "dns-existing", content: "tunnel-existing.cfargotunnel.com", proxied: true }]);
    }
    if (String(url).endsWith("/token")) return response("existing-token");
    throw new Error(`Unexpected Cloudflare request: ${url}`);
  };

  const result = await provisionDeviceTunnel({
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_ZONE_ID: "zone-123",
    CLOUDFLARE_API_TOKEN: "cloudflare-api-secret",
    DASHOU_PUBLIC_DOMAIN: "warmbyte.studio",
  }, { applicationId: "req_abcdefghijklmnop", deviceId: "dev_abcdefghijklmnop" });
  assert.equal(result.tunnelId, "tunnel-existing");
  assert.equal(calls.length, 4);
  assert.equal(calls.some((call) => call.init.method === "POST"), false);
});

test("Cloudflare deprovisioner deletes only the matching registered DNS record and tunnel", async (context) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const tunnelId = "259c5a2a-ae41-4bd0-a189-bd84da4065fb";
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/dns_records?")) {
      return response([
        { id: "dns-match", name: "device-test.warmbyte.studio", content: `${tunnelId}.cfargotunnel.com` },
        { id: "dns-other", name: "device-test.warmbyte.studio", content: "other.cfargotunnel.com" },
      ]);
    }
    if (String(url).endsWith("/dns_records/dns-match") && init.method === "DELETE") return response({ id: "dns-match" });
    if (String(url).endsWith(`/cfd_tunnel/${tunnelId}`) && init.method === "DELETE") return response({ id: tunnelId });
    throw new Error(`Unexpected Cloudflare request: ${url}`);
  };
  const result = await deleteDeviceTunnel({
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_ZONE_ID: "zone-123",
    CLOUDFLARE_API_TOKEN: "cloudflare-api-secret",
    DASHOU_PUBLIC_DOMAIN: "warmbyte.studio",
  }, { tunnelId, hostname: "device-test.warmbyte.studio" });
  assert.equal(result.deletedDnsRecords, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls.some((call) => call.url.includes("dns-other")), false);
});

test("Cloudflare deprovisioner rejects resources outside the Dashou domain", async () => {
  await assert.rejects(() => deleteDeviceTunnel({
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_ZONE_ID: "zone-123",
    CLOUDFLARE_API_TOKEN: "cloudflare-api-secret",
    DASHOU_PUBLIC_DOMAIN: "warmbyte.studio",
  }, {
    tunnelId: "259c5a2a-ae41-4bd0-a189-bd84da4065fb",
    hostname: "unrelated.example.com",
  }), /outside DASHOU_PUBLIC_DOMAIN/);
});

function response(result, status = 200) {
  return new Response(JSON.stringify({ success: status >= 200 && status < 300, result, errors: [] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
