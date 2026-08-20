#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = await readFile(join(root, "index.html"), "utf8");
const source = await Promise.all([
  readFile(join(root, "src", "App.tsx"), "utf8"),
  readFile(join(root, "src", "bridge.ts"), "utf8"),
  readFile(join(root, "src", "state.ts"), "utf8"),
  readFile(join(root, "src", "main.tsx"), "utf8"),
  readFile(join(root, "src", "ErrorBoundary.tsx"), "utf8"),
  readFile(join(root, "src", "components", "SettingsView.tsx"), "utf8"),
  readFile(join(root, "src", "components", "TroubleshootingCard.tsx"), "utf8"),
]);
const stylesheet = await readFile(join(root, "src", "styles.css"), "utf8");
const catalog = JSON.parse(await readFile(join(root, "copy", "default.json"), "utf8"));
const tauri = JSON.parse(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const allSource = source.join("\n");

assert(!existsSync(join(root, "src", "main.js")), "the old DOM entrypoint must be removed");
assert(existsSync(join(root, "src", "assets", "hand-mark.svg")), "the hand brand mark must be packaged with the UI");
assert(existsSync(join(root, "src", "assets", "mascot.png")), "the onboarding mascot must be packaged with the UI");
assert(existsSync(join(root, "..", "assets", "brand", "dashou-hero.jpg")), "the README hero image must be present");
assert(allSource.includes("./assets/hand-mark.svg"), "the UI must use the hand brand mark");
assert(allSource.includes("./assets/mascot.png"), "the setup page must use the mascot");
assert(html.includes("/src/main.tsx"), "index.html must load the typed Preact entrypoint");
assert(!/<script(?![^>]*type=["']module)[^>]*>/.test(html), "index.html must not contain inline scripts");
assert(!/\beval\s*\(|new Function\s*\(/.test(allSource), "UI must not use eval or runtime code generation");
assert(allSource.includes("confirmUiReady"), "UI must confirm downloaded content after Bridge handshake");
assert(allSource.includes("update_allowed_roots"), "UI must use transactional root updates");
assert(allSource.includes("set_preferences"), "UI must persist preferences through the Bridge");
assert(allSource.includes("ErrorBoundary"), "UI must have a crash fallback");
assert(allSource.includes("installUpdate"), "desktop updates must be confirmed separately from update checks");
assert(!source[6].includes("copy.currentVersion"), "the troubleshooting card must not repeat the app version");
assert(!/class=["']version["']/.test(source[0]), "the use page must not repeat the version badge");
assert(/\.toast\s*\{[^}]*opacity:\s*0/.test(stylesheet), "toast must be hidden until it has a message");
assert(/min-width:\s*680px/.test(stylesheet), "desktop UI must support the minimum window width");
const mainWindow = tauri.app?.windows?.find((window) => window.label === "main");
assert.equal(mainWindow?.width, 800, "default desktop width must remain 800px");
assert.equal(mainWindow?.height, 520, "default desktop height must remain 520px");
assert.equal(mainWindow?.minWidth, 680, "minimum desktop width must remain 680px");
assert.equal(mainWindow?.minHeight, 460, "minimum desktop height must remain 460px");
assert.equal(catalog.schemaVersion, 1, "built-in copy schema must be version 1");
for (const key of ["setupTitle", "startSetup", "readyTitle", "trustBody", "helpPath", "autostart"]) {
  assert.equal(typeof catalog.messages[key], "string", `missing built-in copy value: ${key}`);
}
console.log(`desktop UI structure ok: Preact entrypoint, Bridge v2 surfaces, ${Object.keys(catalog.messages).length} copy keys`);
