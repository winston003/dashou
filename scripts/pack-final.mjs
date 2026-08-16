#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const releaseDir = join(projectRoot, "releases");
mkdirSync(releaseDir, { recursive: true });

const packed = JSON.parse(execFileSync("npm", ["pack", "--pack-destination", releaseDir, "--json"], {
  cwd: projectRoot,
  encoding: "utf8",
}))[0];
const packagePath = resolve(releaseDir, packed.filename);
const expectedName = `warmbyte-dashou-${packageJson.version}.tgz`;
if (packed.filename !== expectedName) {
  throw new Error(`npm pack produced ${packed.filename}; expected ${expectedName}`);
}

const entries = execFileSync("tar", ["-tzf", packagePath], { cwd: projectRoot, encoding: "utf8" });
for (const required of [
  "package/package.json",
  "package/dist/dashou-cli.js",
  "package/dist/dashou-capabilities.js",
  "package/dist/dashou-server.js",
  "package/scripts/create-pilot-invite.mjs",
  "package/scripts/pilot-admin.mjs",
  "package/scripts/pilot-admin-config.mjs",
  "package/scripts/setup-pilot-admin.mjs",
]) {
  if (!entries.split("\n").includes(required)) throw new Error(`final package is missing ${required}`);
}
const packagedJson = JSON.parse(execFileSync("tar", ["-xOzf", packagePath, "package/package.json"], { encoding: "utf8" }));
if (packagedJson.version !== packageJson.version || packagedJson.name !== packageJson.name) {
  throw new Error("final package metadata does not match package.json");
}

const temp = mkdtempSync(join(tmpdir(), "dashou-pack-final-"));
try {
  const installDir = join(temp, "install");
  const configDir = join(temp, "config");
  const stateDir = join(temp, "state");
  const env = {
    ...process.env,
    DASHOU_CONFIG_DIR: configDir,
    DASHOU_STATE_DIR: stateDir,
    DASHOU_ALLOWED_ROOTS: temp,
    DASHOU_OAUTH_OWNER_TOKEN: "pack-final-owner-token-123456789",
  };
  execFileSync("npm", ["install", "--prefix", installDir, packagePath, "--no-audit", "--no-fund", "--ignore-scripts"], { stdio: "pipe" });
  const cli = join(installDir, "node_modules", ".bin", "dashou");
  const version = execFileSync(cli, ["--version"], { env, encoding: "utf8" }).trim();
  if (version !== packageJson.version) throw new Error(`fresh package returned version ${version}`);
  const doctor = JSON.parse(execFileSync(cli, ["doctor", "--json"], { env, encoding: "utf8" }));
  if (!doctor.ok || doctor.version !== packageJson.version) throw new Error("fresh package doctor failed");
  if (JSON.stringify(doctor.capabilities?.tools) !== JSON.stringify(["list_projects", "open_project", "read", "write", "edit", "execute"])) {
    throw new Error("fresh package did not report the six-tool contract");
  }
  const adminHelp = execFileSync(cli, ["admin", "--help"], { cwd: temp, env, encoding: "utf8" });
  if (!adminHelp.includes("dashou admin applications approve")) {
    throw new Error("fresh package did not expose the application review CLI");
  }
  const invitePath = join(temp, "pilot-invite.json");
  execFileSync(cli, ["pilot", "invite", invitePath], {
    env: {
      ...env,
      DASHOU_INVITE_PUBLIC_URL: "https://pilot.example.invalid",
      DASHOU_INVITE_PILOT_TOKEN: "pack-final-pilot-token-123456789",
      DASHOU_INVITE_TUNNEL_TOKEN: "pack-final-tunnel-token-123456789",
    },
    stdio: "pipe",
  });
  const invite = JSON.parse(readFileSync(invitePath, "utf8"));
  if (invite.kind !== "dashou-invite" || invite.version !== 1 || invite.publicBaseUrl !== "https://pilot.example.invalid") {
    throw new Error("fresh package did not generate a valid pilot invite");
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  package: packagePath,
  version: packageJson.version,
  sha256: execFileSync("shasum", ["-a", "256", packagePath], { encoding: "utf8" }).trim().split(/\s+/)[0],
  freshInstall: true,
  requiredEntries: ["dist/dashou-cli.js", "dist/dashou-capabilities.js", "dist/dashou-server.js", "scripts/create-pilot-invite.mjs", "scripts/pilot-admin.mjs"],
}, null, 2));
