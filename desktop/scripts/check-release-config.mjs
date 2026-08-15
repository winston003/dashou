#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
if (/-rc\d+$/.test(config.version)) {
  throw new Error("Desktop release is blocked: use ordered prerelease versions such as 0.1.3-rc.1, not 0.1.3-rc1.");
}
const pubkey = config.plugins?.updater?.pubkey;
if (!pubkey || pubkey.includes("REQUIRED") || pubkey.length < 100) {
  throw new Error("Desktop release is blocked: configure the Tauri updater public key before building a distributable installer.");
}
if (!config.plugins?.updater?.endpoints?.length) {
  throw new Error("Desktop release is blocked: configure a signed updater endpoint.");
}
if (process.platform === "darwin" && !process.env.APPLE_SIGNING_IDENTITY && !config.bundle?.macOS?.signingIdentity) {
  throw new Error("Desktop release is blocked: configure a macOS signing identity or explicit ad-hoc identity.");
}
console.log(JSON.stringify({
  ok: true,
  updaterEndpoint: config.plugins.updater.endpoints[0],
  updaterKeyConfigured: true,
  ...(process.platform === "darwin" ? { macSigningIdentityConfigured: true } : {}),
}, null, 2));
