#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function assertControlPlaneCompatible(health, requirements) {
  const requiredApiVersion = requirements?.requiredApiVersion;
  if (!Number.isInteger(requiredApiVersion) || requiredApiVersion < 1) {
    throw new Error("requiredApiVersion must be a positive integer");
  }
  if (!Number.isInteger(health?.apiVersion)) {
    throw new Error("Online control plane does not advertise apiVersion");
  }
  if (health.apiVersion < requiredApiVersion) {
    throw new Error(`Online control-plane API ${health.apiVersion} is below required API ${requiredApiVersion}`);
  }
  const onlineCapabilities = new Set(health.capabilities ?? []);
  const missing = [...new Set(requirements.requiredCapabilities ?? [])]
    .filter((capability) => !onlineCapabilities.has(capability))
    .sort();
  if (missing.length > 0) {
    throw new Error(`Online control plane is missing required capabilities: ${missing.join(", ")}`);
  }
  return {
    serviceVersion: health.serviceVersion ?? health.version ?? "unknown",
    onlineApiVersion: health.apiVersion,
    requiredApiVersion,
  };
}

function main() {
  const requirements = JSON.parse(readFileSync(
    new URL("../desktop/control-plane-requirements.json", import.meta.url),
    "utf8",
  ));
  const healthUrl = process.env.DASHOU_CONTROL_HEALTH_URL?.trim()
    || "https://dashou-pilot-control.whilewon.workers.dev/healthz";
  const health = JSON.parse(execFileSync("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--connect-timeout", "15",
    "--max-time", "30",
    healthUrl,
  ], { encoding: "utf8", timeout: 35_000 }));
  console.log(JSON.stringify({
    ok: true,
    healthUrl,
    ...assertControlPlaneCompatible(health, requirements),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
