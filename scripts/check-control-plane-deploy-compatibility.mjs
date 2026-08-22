#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  CONTROL_PLANE_API_VERSION,
  CONTROL_PLANE_CAPABILITIES,
  CONTROL_PLANE_SERVICE_VERSION,
} from "../control-plane/src/service-metadata.js";

export function assertNoControlPlaneRegression(remote, candidate = {
  serviceVersion: CONTROL_PLANE_SERVICE_VERSION,
  apiVersion: CONTROL_PLANE_API_VERSION,
  capabilities: CONTROL_PLANE_CAPABILITIES,
}) {
  if (!Number.isInteger(candidate.apiVersion) || candidate.apiVersion < 1) {
    throw new Error("Candidate control-plane apiVersion must be a positive integer");
  }
  if (Number.isInteger(remote?.apiVersion) && remote.apiVersion > candidate.apiVersion) {
    throw new Error(`Refusing API downgrade: online=${remote.apiVersion}, candidate=${candidate.apiVersion}`);
  }
  const candidateCapabilities = new Set(candidate.capabilities ?? []);
  const missing = [...new Set(remote?.capabilities ?? [])]
    .filter((capability) => !candidateCapabilities.has(capability))
    .sort();
  if (missing.length > 0) {
    throw new Error(`Refusing capability regression; candidate is missing: ${missing.join(", ")}`);
  }
  return {
    onlineServiceVersion: remote?.serviceVersion ?? remote?.version ?? "legacy",
    onlineApiVersion: Number.isInteger(remote?.apiVersion) ? remote.apiVersion : 0,
    candidateServiceVersion: candidate.serviceVersion,
    candidateApiVersion: candidate.apiVersion,
    candidateCapabilities: [...candidateCapabilities].sort(),
  };
}

function readRemoteHealth(url) {
  const proxyArgs = localProxyAvailable() ? ["--proxy", "http://127.0.0.1:1082"] : [];
  const body = execFileSync("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--connect-timeout", "15",
    "--max-time", "30",
    ...proxyArgs,
    url,
  ], { encoding: "utf8", timeout: 35_000 });
  return JSON.parse(body);
}

function localProxyAvailable() {
  try {
    execFileSync("/usr/bin/nc", ["-z", "-w", "1", "127.0.0.1", "1082"], {
      stdio: "ignore",
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const url = process.env.DASHOU_CONTROL_HEALTH_URL?.trim()
    || "https://dashou-pilot-control.whilewon.workers.dev/healthz";
  const remote = readRemoteHealth(url);
  const expectedBuildSha = process.env.DASHOU_EXPECT_BUILD_SHA?.trim();
  if (expectedBuildSha && remote?.buildSha !== expectedBuildSha) {
    throw new Error(`Deployed build SHA mismatch: online=${remote?.buildSha ?? "missing"}, expected=${expectedBuildSha}`);
  }
  const result = assertNoControlPlaneRegression(remote);
  console.log(JSON.stringify({ ok: true, healthUrl: url, ...result }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
