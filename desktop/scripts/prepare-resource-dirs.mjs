#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
for (const directory of ["node-runtime", "dashou-runtime", "cloudflared"]) {
  await mkdir(join(desktopRoot, "vendor", directory), { recursive: true });
}
console.log("desktop resource directories ready");
