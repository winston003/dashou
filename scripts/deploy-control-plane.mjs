#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const repo = resolve(new URL("..", import.meta.url).pathname);
const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: repo, encoding: "utf8" });
if (status.trim()) throw new Error("Refusing Control Plane deployment from a dirty working tree; commit the release first.");
const branch = execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim();
if (branch !== "codex/control-plane-production") {
  throw new Error(`Refusing production Control Plane deployment from ${branch || "detached HEAD"}; use codex/control-plane-production.`);
}
const buildSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
execFileSync("npx", ["wrangler", "whoami", "--config", "control-plane/wrangler.jsonc"], { cwd: repo, stdio: "inherit" });
execFileSync("npm", ["run", "verify:control-plane"], { cwd: repo, stdio: "inherit" });
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "dashou-pilot-control", "--remote", "--config", "control-plane/wrangler.jsonc"], { cwd: repo, stdio: "inherit" });
execFileSync("npx", ["wrangler", "deploy", "--config", "control-plane/wrangler.jsonc", "--strict", "--message", `dashou-control-plane ${buildSha.slice(0, 12)}`, "--var", `DASHOU_BUILD_SHA:${buildSha}`], { cwd: repo, stdio: "inherit" });
