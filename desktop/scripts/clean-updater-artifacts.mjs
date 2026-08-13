#!/usr/bin/env node

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundleRoot = fileURLToPath(new URL("../src-tauri/target/release/bundle/", import.meta.url));
const directories = ["macos", "windows"];
const suffixes = [".tar.gz", ".tar.gz.sig", ".nsis.zip", ".nsis.zip.sig"];

for (const directory of directories) {
  const path = join(bundleRoot, directory);
  let entries;
  try {
    entries = await readdir(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
    throw error;
  }
  for (const entry of entries) {
    if (suffixes.some((suffix) => entry.endsWith(suffix))) {
      await rm(join(path, entry), { force: true });
    }
  }
}

console.log(JSON.stringify({ ok: true, cleaned: true }));
