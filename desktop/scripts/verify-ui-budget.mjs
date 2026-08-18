#!/usr/bin/env node
import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(desktopRoot, "dist-ui");
const entries = await collectFiles(distRoot);
const frontendBytes = Object.entries(entries)
  .filter(([name]) => /\.(?:js|css)$/i.test(name))
  .reduce((total, [, bytes]) => total + gzipSync(bytes, { level: 9 }).length, 0);
const uiZipBytes = zipSync(entries, { level: 9 }).length;
const frontendLimit = 40 * 1024;
const zipLimit = 250 * 1024;

if (frontendBytes > frontendLimit) {
  throw new Error(`frontend gzip budget exceeded: ${frontendBytes} > ${frontendLimit}`);
}
if (uiZipBytes > zipLimit) {
  throw new Error(`signed UI zip budget exceeded: ${uiZipBytes} > ${zipLimit}`);
}
console.log(`UI budget ok: JS+CSS gzip ${frontendBytes} bytes, UI zip ${uiZipBytes} bytes`);

async function collectFiles(root, current = root) {
  const result = {};
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) Object.assign(result, await collectFiles(root, path));
    else if (entry.isFile()) result[relative(root, path).replaceAll("\\", "/")] = new Uint8Array(await readFile(path));
  }
  return result;
}
