#!/usr/bin/env node

import { basename, resolve } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";

const version = requiredEnv("DASHOU_RELEASE_VERSION");
const baseUrl = requiredUrl(requiredEnv("DASHOU_RELEASE_BASE_URL"));
const outputPath = resolve(process.env.DASHOU_UPDATER_MANIFEST_PATH?.trim() || "latest.json");
const notes = process.env.DASHOU_RELEASE_NOTES?.trim() || `Dashou desktop ${version}`;
const artifacts = [
  ["darwin-aarch64", requiredEnv("DASHOU_MAC_ARM64_ARCHIVE"), requiredEnv("DASHOU_MAC_ARM64_SIGNATURE")],
  ["darwin-x86_64", requiredEnv("DASHOU_MAC_X64_ARCHIVE"), requiredEnv("DASHOU_MAC_X64_SIGNATURE")],
  ["windows-x86_64", requiredEnv("DASHOU_WINDOWS_ARCHIVE"), requiredEnv("DASHOU_WINDOWS_SIGNATURE")],
];

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`DASHOU_RELEASE_VERSION is not a semver: ${version}`);
}

const platforms = {};
for (const [target, archivePath, signaturePath] of artifacts) {
  await requireFile(archivePath, `${target} archive`);
  const signature = (await readFile(signaturePath, "utf8")).trim();
  if (!signature) throw new Error(`${target} updater signature is empty: ${signaturePath}`);
  const archiveName = basename(archivePath);
  platforms[target] = {
    signature,
    url: new URL(encodeURIComponent(archiveName), `${baseUrl.href.replace(/\/$/, "")}/`).href,
  };
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
await writeFile(outputPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ ok: true, output: outputPath, version, platforms: Object.keys(platforms) }, null, 2));

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("DASHOU_RELEASE_BASE_URL must use https");
  return url;
}

async function requireFile(path, label) {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size === 0) throw new Error("empty or not a file");
  } catch (error) {
    throw new Error(`Missing ${label}: ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
}
