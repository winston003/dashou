#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const json = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
const rootPackage = await json("package.json");
const desktopPackage = await json("desktop/package.json");
const desktopLock = await json("desktop/package-lock.json");
const rootLock = await json("package-lock.json");
const tauri = await json("desktop/src-tauri/tauri.conf.json");
const cargo = await readFile(join(root, "desktop/src-tauri/Cargo.toml"), "utf8");
const releaseNotes = await readFile(join(root, "docs/RELEASE_NOTES.md"), "utf8");
const expected = process.env.DASHOU_EXPECTED_VERSION?.trim() || rootPackage.version;
assert.match(expected, /^\d+\.\d+\.\d+-rc\.\d+$/, "release version must use an ordered rc suffix");
const values = [
  ["root package", rootPackage.version],
  ["desktop package", desktopPackage.version],
  ["root lock", rootLock.version],
  ["desktop lock", desktopLock.version],
  ["tauri config", tauri.version],
  ["cargo manifest", cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]],
];
for (const [label, value] of values) assert.equal(value, expected, `${label} version is ${value}, expected ${expected}`);
assert.equal(releaseNotes.match(/^#\s+([^\s]+)$/m)?.[1], expected, "release notes heading must match the release version");
console.log(JSON.stringify({ ok: true, version: expected, checked: [...values.map(([label]) => label), "release notes"] }, null, 2));
