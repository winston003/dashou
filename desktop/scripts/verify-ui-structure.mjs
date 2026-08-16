#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = await readFile(join(root, "index.html"), "utf8");
const javascript = await readFile(join(root, "src", "main.js"), "utf8");
const stylesheet = await readFile(join(root, "src", "styles.css"), "utf8");
const builtInCopy = JSON.parse(await readFile(join(root, "copy", "default.json"), "utf8"));

const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(htmlIds).size, htmlIds.length, "desktop HTML must not contain duplicate ids");

const referencedIds = [...javascript.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]);
for (const id of new Set(referencedIds)) {
  assert(htmlIds.includes(id), `main.js references missing HTML id: ${id}`);
}

const accessStep = html.indexOf('<div class="setup-step">');
const applyButton = html.indexOf('id="apply-access"');
const folderStep = html.indexOf('id="folder-step"');
const folderButton = html.indexOf('id="choose-folder"');
assert(accessStep >= 0 && accessStep < applyButton, "join-trial step must always be visible");
assert(folderStep > applyButton && folderStep < folderButton, "folder controls must be inside the gated folder step");
assert(javascript.includes('location.protocol === "dashou-ui:"'), "built-in UI must not acknowledge a downloaded UI update");
assert(/\.hidden\s*\{[^}]*display:\s*none\s*!important/.test(stylesheet), "hidden utility must override button display styles");

for (const key of ["setupTitle", "joinTrial", "readyTitle", "trustBody", "failureBody"]) {
  assert(typeof builtInCopy.messages[key] === "string", `missing built-in copy value: ${key}`);
}

console.log(`desktop UI structure ok: ${htmlIds.length} unique ids, ${new Set(referencedIds).size} referenced ids`);
