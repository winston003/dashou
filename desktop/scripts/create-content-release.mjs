#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
const version = required("DASHOU_CONTENT_VERSION");
const minShellVersion = process.env.DASHOU_MIN_SHELL_VERSION?.trim() || packageJson.version;
const kind = process.env.DASHOU_CONTENT_KIND?.trim() || "both";
const outputRoot = resolve(process.env.DASHOU_CONTENT_OUTPUT?.trim() || join(desktopRoot, "release-content"));
const releaseRepo = "https://github.com/winston003/dashou-releases/releases/download";

if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) throw new Error("DASHOU_CONTENT_VERSION is invalid");
if (!/^(ui|copy|both)$/.test(kind)) throw new Error("DASHOU_CONTENT_KIND must be ui, copy, or both");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw new Error("TAURI_SIGNING_PRIVATE_KEY is required");

await mkdir(outputRoot, { recursive: true });
if (kind === "ui" || kind === "both") await packageUi();
if (kind === "copy" || kind === "both") await packageCopy();

async function packageUi() {
  const source = join(desktopRoot, "dist-ui");
  const entries = await collectFiles(source);
  if (!entries["index.html"]) throw new Error("dist-ui/index.html is missing; build the frontend first");
  const filename = `dashou-ui-${version}.zip`;
  const path = join(outputRoot, filename);
  await writeFile(path, zipSync(entries, { level: 9 }));
  await writeManifest({
    path,
    manifestPath: join(outputRoot, "ui-latest.json"),
    url: `${releaseRepo}/ui-current/${filename}`,
    bridgeVersion: 1,
  });
}

async function packageCopy() {
  const template = JSON.parse(await readFile(join(desktopRoot, "copy", "default.json"), "utf8"));
  template.version = version;
  const filename = `dashou-copy-${version}.json`;
  const path = join(outputRoot, filename);
  await writeFile(path, JSON.stringify(template, null, 2) + "\n");
  await writeManifest({
    path,
    manifestPath: join(outputRoot, "copy-latest.json"),
    url: `${releaseRepo}/copy-current/${filename}`,
  });
}

async function writeManifest({ path, manifestPath, url, bridgeVersion }) {
  const tauri = process.platform === "win32" ? "tauri.cmd" : "tauri";
  execFileSync(join(desktopRoot, "node_modules", ".bin", tauri), ["signer", "sign", path], {
    cwd: desktopRoot,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const bytes = await readFile(path);
  const signature = (await readFile(`${path}.sig`, "utf8")).trim();
  const manifest = {
    schemaVersion: 1,
    version,
    minShellVersion,
    ...(bridgeVersion ? { bridgeVersion } : {}),
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(`created ${basename(path)} and ${basename(manifestPath)}\n`);
}

async function collectFiles(root, relative = "") {
  const { readdir } = await import("node:fs/promises");
  const output = {};
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(output, await collectFiles(root, child));
    else if (entry.isFile()) output[child] = new Uint8Array(await readFile(join(root, child)));
    else throw new Error(`unsupported UI entry: ${child}`);
  }
  return output;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
