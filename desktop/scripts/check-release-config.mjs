#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const pubkey = config.plugins?.updater?.pubkey;
if (!pubkey || pubkey.includes("REQUIRED") || pubkey.length < 100) {
  throw new Error("Desktop release is blocked: configure the Tauri updater public key before building a distributable installer.");
}
if (!config.plugins?.updater?.endpoints?.length) {
  throw new Error("Desktop release is blocked: configure a signed updater endpoint.");
}
console.log(JSON.stringify({
  ok: true,
  updaterEndpoint: config.plugins.updater.endpoints[0],
  updaterKeyConfigured: true,
}, null, 2));
