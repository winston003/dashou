#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { mkdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { installCliUpdate, updateCheck } from "../src/dashou-upgrade.ts";

const execFile = promisify(execFileCallback);
const repo = new URL("..", import.meta.url).pathname;
const currentPackage = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
const currentPackagePath = join(repo, "releases", `warmbyte-dashou-${currentPackage.version}.tgz`);
const bytes = await readFile(currentPackagePath);
const packageSha256 = createHash("sha256").update(bytes).digest("hex");
const tempPrefix = await mkdtemp(join(tmpdir(), "dashou-upgrade-asset-"));
const oldPackageRoot = join(tempPrefix, "old-package");
const oldPackagePath = join(tempPrefix, "warmbyte-dashou-0.1.1.tgz");

// Keep the upgrade smoke self-contained. The historical 0.1.1 tarball is not
// a source artifact and should not have to exist in an ignored local releases/
// directory just to run the release gate. Repackage the current reviewed
// artifact with an old version marker, then exercise a real npm global upgrade.
await mkdir(oldPackageRoot, { recursive: true });
execFileSync("tar", ["-xzf", currentPackagePath, "-C", oldPackageRoot]);
const oldMetadata = JSON.parse(await readFile(join(oldPackageRoot, "package", "package.json"), "utf8"));
oldMetadata.version = "0.1.1";
await writeFile(join(oldPackageRoot, "package", "package.json"), JSON.stringify(oldMetadata, null, 2) + "\n");
execFileSync("tar", ["-czf", oldPackagePath, "-C", oldPackageRoot, "package"]);

try {
  const npmEnv = { ...process.env, npm_config_prefix: tempPrefix, npm_config_update_notifier: "false" };
  await execFile("npm", ["install", "--global", oldPackagePath, "--no-audit", "--no-fund"], { env: npmEnv, maxBuffer: 4 * 1024 * 1024 });
  const cli = join(tempPrefix, "bin", "dashou");
  const before = execFileSync(cli, ["--version"], { env: npmEnv, encoding: "utf8" }).trim();
  if (before !== oldMetadata.version) throw new Error(`old CLI installed as ${before}, expected ${oldMetadata.version}`);
  const check = updateCheck(oldMetadata.version, {
    kind: "dashou-cli",
    packageName: currentPackage.name,
    version: currentPackage.version,
    packageUrl: `https://github.com/winston003/dashou-releases/releases/download/v${currentPackage.version}/dashou-cli-v${currentPackage.version}.tgz`,
    packageSha256,
  }, "https://github.com/winston003/dashou-releases/releases/latest/download/cli-latest.json");
  if (!check.updateAvailable) throw new Error("upgrade smoke did not detect the candidate release");
  const fetchImpl = async () => new Response(bytes, { status: 200 });
  const execWithIsolatedPrefix = (file, args, options) => execFile(file, args, { ...options, env: npmEnv });
  await installCliUpdate(check, execWithIsolatedPrefix, fetchImpl);
  const after = execFileSync(cli, ["--version"], { env: npmEnv, encoding: "utf8" }).trim();
  if (after !== currentPackage.version) throw new Error(`upgraded CLI is ${after}, expected ${currentPackage.version}`);
  console.log(JSON.stringify({ ok: true, from: before, to: after, packageSha256 }, null, 2));
} finally {
  await rm(tempPrefix, { recursive: true, force: true });
}
