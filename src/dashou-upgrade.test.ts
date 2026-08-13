import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { compareVersions, downloadAndVerifyPackage, isTrustedPackageUrl, updateCheck, updatePlatform } from "./dashou-upgrade.js";

test("GitHub update check compares release versions and selects the platform", () => {
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
  assert.equal(compareVersions("v0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.1.2-rc1", "0.1.2"), -1);
  assert.equal(compareVersions("0.1.2", "0.1.2-rc1"), 1);
  assert.equal(updatePlatform("darwin", "arm64"), "darwin-aarch64");
  const result = updateCheck(
    "0.1.0",
    { kind: "dashou-cli", packageName: "@warmbyte/dashou", version: "0.2.0", notes: "pilot update", packageUrl: "https://registry.npmjs.org/@warmbyte/dashou/-/dashou-0.2.0.tgz", packageSha256: "a".repeat(64) },
    "https://github.com/example/latest.json",
    "darwin-aarch64",
  );
  assert.deepEqual(result, {
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    updateAvailable: true,
    manifestUrl: "https://github.com/example/latest.json",
    platform: "darwin-aarch64",
    downloadUrl: "https://registry.npmjs.org/@warmbyte/dashou/-/dashou-0.2.0.tgz",
    packageSha256: "a".repeat(64),
    notes: "pilot update",
  });
});

test("CLI update packages require a trusted HTTPS URL and matching SHA-256", async () => {
  assert.equal(isTrustedPackageUrl("https://registry.npmjs.org/@warmbyte/dashou/-/dashou-0.2.0.tgz"), true);
  assert.equal(isTrustedPackageUrl("https://evil.example/dashou-cli-0.2.0.tgz"), false);
  assert.equal(isTrustedPackageUrl("https://github.com/winston003/dashou-releases/releases/download/v0.2.0/dashou-cli-v0.2.0.tgz"), true);
  assert.equal(isTrustedPackageUrl("https://github.com/winston003/dashou-releases/releases/download/v0.1.2-rc1/dashou-cli-v0.1.2-rc1.tgz"), true);
  assert.equal(isTrustedPackageUrl("https://github.com/winston003/dashou-releases/releases/download/v0.2.0/dashou.app.tar.gz"), false);

  const bytes = Buffer.from("verified dashou package");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const fetchImpl: typeof fetch = async () => new Response(bytes, { status: 200 });
  assert.deepEqual(await downloadAndVerifyPackage(
    "https://registry.npmjs.org/@warmbyte/dashou/-/dashou-0.2.0.tgz",
    sha256,
    fetchImpl,
  ), bytes);
  await assert.rejects(
    downloadAndVerifyPackage(
      "https://registry.npmjs.org/@warmbyte/dashou/-/dashou-0.2.0.tgz",
      "b".repeat(64),
      fetchImpl,
    ),
    /SHA-256 does not match/,
  );
});
