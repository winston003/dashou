#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, chmod, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "..");
const vendorRoot = join(desktopRoot, "vendor");
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const windows = process.platform === "win32";
const nodeName = windows ? "node.exe" : "node";
const cloudflaredName = windows ? "cloudflared.exe" : "cloudflared";
const nodeSource = process.env.DASHOU_NODE_BINARY || process.execPath;
const cloudflaredUrl = process.env.DASHOU_CLOUDFLARED_URL;
const expectedCloudflaredSha256 = process.env.DASHOU_CLOUDFLARED_SHA256?.trim().toLowerCase();
let downloadedCloudflaredDir;
let sourceSnapshotDir;

try {
  const cloudflaredSource = process.env.DASHOU_CLOUDFLARED_BINARY
    || (cloudflaredUrl ? await downloadCloudflared(cloudflaredUrl) : findOnPath(cloudflaredName));

  if (!existsSync(nodeSource)) throw new Error("Node runtime not found: " + nodeSource);
  if (!cloudflaredSource || !existsSync(cloudflaredSource)) {
    throw new Error("cloudflared not found; set DASHOU_CLOUDFLARED_BINARY or DASHOU_CLOUDFLARED_URL");
  }
  const cloudflaredSha256 = createHash("sha256").update(await readFile(cloudflaredSource)).digest("hex");
  if (expectedCloudflaredSha256 && !/^[a-f0-9]{64}$/.test(expectedCloudflaredSha256)) {
    throw new Error("DASHOU_CLOUDFLARED_SHA256 must be a 64-character lowercase hexadecimal SHA-256");
  }
  if (expectedCloudflaredSha256 && cloudflaredSha256 !== expectedCloudflaredSha256) {
    throw new Error("cloudflared SHA-256 does not match the release configuration");
  }
  if ((process.env.CI || cloudflaredUrl) && !expectedCloudflaredSha256) {
    throw new Error("CI desktop build requires DASHOU_CLOUDFLARED_SHA256 for the reviewed cloudflared binary");
  }

  // A local rebuild may point DASHOU_CLOUDFLARED_BINARY at the currently
  // staged vendor file. Snapshot sources that live under vendorRoot before
  // clearing the destination directories below, otherwise the build deletes
  // its own input before copyFile() runs.
  const stagedNodeSource = await snapshotIfInsideVendor(nodeSource, nodeName);
  const stagedCloudflaredSource = await snapshotIfInsideVendor(cloudflaredSource, cloudflaredName);

  execFileSync(process.execPath, [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(repoRoot, "tsconfig.build.json")], { cwd: repoRoot, stdio: "inherit" });

  const nodeDir = join(vendorRoot, "node-runtime");
  const runtimeDir = join(vendorRoot, "dashou-runtime");
  const cloudDir = join(vendorRoot, "cloudflared");
  await Promise.all([
    rm(nodeDir, { recursive: true, force: true }),
    rm(runtimeDir, { recursive: true, force: true }),
    rm(cloudDir, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(nodeDir, { recursive: true }),
    mkdir(runtimeDir, { recursive: true }),
    mkdir(cloudDir, { recursive: true }),
  ]);
  await copyFile(stagedNodeSource, join(nodeDir, nodeName));
  await copyFile(stagedCloudflaredSource, join(cloudDir, cloudflaredName));
  if (!windows) {
    await chmod(join(nodeDir, nodeName), 0o755);
    await chmod(join(cloudDir, cloudflaredName), 0o755);
  }
  await cp(join(repoRoot, "dist"), join(runtimeDir, "dist"), { recursive: true });
  await writeFile(join(runtimeDir, "package.json"), JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    type: packageJson.type,
    dependencies: packageJson.dependencies,
  }, null, 2) + "\n");
  execFileSync("npm", ["install", "--prefix", runtimeDir, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: repoRoot, stdio: "inherit" });

  console.log(JSON.stringify({
    ok: true,
    version: packageJson.version,
    node: join(nodeDir, nodeName),
    cloudflared: join(cloudDir, cloudflaredName),
    cloudflaredSha256,
    runtime: runtimeDir,
  }, null, 2));
} finally {
  if (downloadedCloudflaredDir) {
    await rm(downloadedCloudflaredDir, { recursive: true, force: true });
  }
  if (sourceSnapshotDir) {
    await rm(sourceSnapshotDir, { recursive: true, force: true });
  }
}

async function snapshotIfInsideVendor(source, name) {
  const sourcePath = resolve(source);
  const vendorPath = resolve(vendorRoot) + "/";
  if (!sourcePath.startsWith(vendorPath)) return sourcePath;
  sourceSnapshotDir ??= await mkdtemp(join(tmpdir(), "dashou-runtime-sources-"));
  const snapshotPath = join(sourceSnapshotDir, name);
  await copyFile(sourcePath, snapshotPath);
  return snapshotPath;
}

async function downloadCloudflared(urlValue) {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/cloudflare/cloudflared/releases/download/")) {
    throw new Error("DASHOU_CLOUDFLARED_URL must point to an official Cloudflare GitHub release asset");
  }
  if (windows && !url.pathname.endsWith("-windows-amd64.exe")) {
    throw new Error("Windows desktop builds require the cloudflared windows-amd64 executable asset");
  }
  if (!windows && !url.pathname.endsWith("-darwin-arm64.tgz") && !url.pathname.endsWith("-darwin-amd64.tgz")) {
    throw new Error("macOS desktop builds require a cloudflared Darwin tgz asset");
  }

  downloadedCloudflaredDir = await mkdtemp(join(tmpdir(), "dashou-cloudflared-"));
  const assetName = url.pathname.split("/").pop() || "cloudflared-asset";
  const assetPath = join(downloadedCloudflaredDir, assetName);
  try {
    execFileSync(windows ? "curl.exe" : "curl", [
      "--fail",
      "--location",
      "--retry", "3",
      "--connect-timeout", "20",
      "--max-time", "300",
      "--output", assetPath,
      url.href,
    ], { stdio: "inherit" });
  } catch {
    const response = await fetch(url, { headers: { "User-Agent": "dashou-desktop-release" } });
    if (!response.ok) throw new Error(`Unable to download cloudflared: HTTP ${response.status}`);
    await writeFile(assetPath, Buffer.from(await response.arrayBuffer()));
  }

  if (assetName.endsWith(".tgz")) {
    const extractedDir = join(downloadedCloudflaredDir, "extracted");
    await mkdir(extractedDir, { recursive: true });
    execFileSync("tar", ["-xzf", assetPath, "-C", extractedDir], { stdio: "inherit" });
    return join(extractedDir, "cloudflared");
  }
  return assetPath;
}

function findOnPath(name) {
  try {
    return execFileSync(windows ? "where" : "which", [name], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
  } catch {
    return undefined;
  }
}
