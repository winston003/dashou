#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(desktopRoot, "src-tauri", "tauri.conf.json");
const config = JSON.parse(await readFile(path, "utf8"));
const pubkey = process.env.DASHOU_UPDATER_PUBLIC_KEY?.trim();
if (!pubkey || pubkey.length < 100) {
  throw new Error("DASHOU_UPDATER_PUBLIC_KEY is required for a desktop release");
}
config.plugins.updater.pubkey = pubkey;
await writeFile(path, JSON.stringify(config, null, 2) + "\n");
console.log("configured desktop updater public key");
