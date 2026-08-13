#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const packageUrl = required(args, "package-url");
const packageFile = args["package-file"] ? resolve(projectRoot, args["package-file"]) : undefined;
const packageSha256 = args["package-sha256"] ?? (packageFile ? await sha256(packageFile) : undefined);
if (!packageSha256 || !/^[a-f0-9]{64}$/i.test(packageSha256)) {
  throw new Error("provide --package-sha256 or --package-file with a valid tarball");
}
if (!isTrustedPackageUrl(packageUrl)) throw new Error("package URL must be a trusted npm or GitHub CLI tarball URL");

const output = resolve(projectRoot, args.output ?? "releases/cli-latest.json");
const manifest = {
  kind: "dashou-cli",
  packageName: packageJson.name,
  version: args.version ?? packageJson.version,
  pub_date: new Date().toISOString(),
  packageUrl,
  packageSha256: packageSha256.toLowerCase(),
  ...(args.notes ? { notes: args.notes } : {}),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(output);
console.log(JSON.stringify(manifest, null, 2));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for --${key}`);
    result[key] = next;
    index += 1;
  }
  return result;
}

function required(values, key) {
  const value = values[key]?.trim();
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function isTrustedPackageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
  if (url.hostname === "registry.npmjs.org") {
    return new RegExp(`^/@warmbyte/dashou/-/dashou-v?${SEMVER_PATTERN}\\.tgz$`).test(url.pathname);
  }
  return url.href.startsWith("https://github.com/winston003/dashou-releases/releases/download/")
    && new RegExp(`/dashou-cli-v?${SEMVER_PATTERN}\\.tgz$`).test(url.pathname);
}

const SEMVER_PATTERN = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";
