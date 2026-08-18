#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = join(desktopRoot, "vendor", "dashou-runtime");
const packageJson = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
const runtimePackage = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
const capabilities = await readFile(join(runtimeRoot, "dist", "dashou-capabilities.js"), "utf8");
const server = await readFile(join(runtimeRoot, "dist", "dashou-server.js"), "utf8");

assert.equal(runtimePackage.version, packageJson.version, "staged Dashou runtime version does not match Desktop");
assert.ok(!existsSync(join(runtimeRoot, "dist", "dashou-artifact.js")), "staged runtime must not include save_artifact implementation");
assert.match(capabilities, /\["list_projects", "open_project", "read", "write", "edit", "execute"\]/);
assert.doesNotMatch(server, /registerTool\("save_artifact"/);

console.log(JSON.stringify({
  ok: true,
  version: runtimePackage.version,
  tools: ["list_projects", "open_project", "read", "write", "edit", "execute"],
  artifactRuntime: false,
}, null, 2));
