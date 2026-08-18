#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageJson = await readJson("package.json");
const desktopPackageJson = await readJson("desktop/package.json");
const tauriConfig = await readJson("desktop/src-tauri/tauri.conf.json");
const packageLock = await readJson("package-lock.json");
const desktopPackageLock = await readJson("desktop/package-lock.json");
const cargoToml = await readText("desktop/src-tauri/Cargo.toml");
const cargoLock = await readText("desktop/src-tauri/Cargo.lock");
const controlPlane = await readText("control-plane/src/index.js");

const version = packageJson.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)) {
  throw new Error(`Root package version must be an ordered rc semver, got ${String(version)}`);
}

const checks = [
  ["desktop/package.json", desktopPackageJson.version],
  ["desktop/src-tauri/tauri.conf.json", tauriConfig.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json root package", packageLock.packages?.[""]?.version],
  ["desktop/package-lock.json", desktopPackageLock.version],
  ["desktop/package-lock.json root package", desktopPackageLock.packages?.[""]?.version],
];
for (const [label, value] of checks) {
  if (value !== version) throw new Error(`${label} has version ${String(value)}; expected ${version}`);
}
if (!new RegExp(`^version = "${escapeRegExp(version)}"$`, "m").test(cargoToml)) {
  throw new Error(`desktop/src-tauri/Cargo.toml does not declare ${version}`);
}
if (!new RegExp(`name = "dashou-desktop"\\nversion = "${escapeRegExp(version)}"`, "m").test(cargoLock)) {
  throw new Error(`desktop/src-tauri/Cargo.lock does not declare ${version} for dashou-desktop`);
}
const controlPlaneVersion = /const CONTROL_PLANE_VERSION = "([^"]+)"/.exec(controlPlane)?.[1];
if (controlPlaneVersion !== version) {
  throw new Error(`control-plane/src/index.js has version ${String(controlPlaneVersion)}; expected ${version}`);
}

console.log(JSON.stringify({ ok: true, version, checked: checks.map(([label]) => label).concat([
  "desktop/src-tauri/Cargo.toml",
  "desktop/src-tauri/Cargo.lock",
  "control-plane/src/index.js",
]) }, null, 2));

async function readText(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
