import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

// The desktop release uses Tauri's `latest.json`; keep the CLI manifest separate.
export const DEFAULT_UPDATE_MANIFEST_URL = "https://github.com/winston003/dashou-releases/releases/latest/download/cli-latest.json";
const TRUSTED_GITHUB_RELEASE_PREFIX = "https://github.com/winston003/dashou-releases/releases/download/";
const TRUSTED_NPM_REGISTRY_HOST = "registry.npmjs.org";
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const execFile = promisify(execFileCallback);

export interface DashouUpdatePlatform {
  url?: string;
  signature?: string;
  sha256?: string;
}

export interface DashouUpdateManifest {
  kind: "dashou-cli";
  packageName: "@warmbyte/dashou";
  version: string;
  notes?: string;
  pub_date?: string;
  packageUrl?: string;
  packageSha256?: string;
  platforms?: Record<string, DashouUpdatePlatform>;
}

export interface DashouUpdateCheck {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  manifestUrl: string;
  platform: string;
  downloadUrl?: string;
  packageSha256?: string;
  notes?: string;
}

export function updateManifestUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DASHOU_UPDATE_MANIFEST_URL?.trim() || DEFAULT_UPDATE_MANIFEST_URL;
}

export function updatePlatform(platform = process.platform, arch = process.arch): string {
  if (platform === "darwin" && arch === "arm64") return "darwin-aarch64";
  if (platform === "darwin" && arch === "x64") return "darwin-x86_64";
  if (platform === "linux" && arch === "arm64") return "linux-aarch64";
  if (platform === "linux" && arch === "x64") return "linux-x86_64";
  return `${platform}-${arch}`;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; pre: string[] } => {
    const [coreText, preText] = value.replace(/^v/, "").split("-", 2);
    return {
      core: coreText.split(".").map((part) => Number(part)),
      pre: preText ? preText.split(".") : [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) return delta;
  }
  if (a.pre.length === 0 && b.pre.length > 0) return 1;
  if (a.pre.length > 0 && b.pre.length === 0) return -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const leftPart = a.pre[index];
    const rightPart = b.pre[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const delta = Number(leftPart) - Number(rightPart);
      if (delta !== 0) return delta;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

export function updateCheck(currentVersion: string, manifest: DashouUpdateManifest, manifestUrl: string, platform = updatePlatform()): DashouUpdateCheck {
  const platformArtifact = manifest.platforms?.[platform];
  return {
    currentVersion,
    latestVersion: manifest.version,
    updateAvailable: compareVersions(manifest.version, currentVersion) > 0,
    manifestUrl,
    platform,
    downloadUrl: manifest.packageUrl ?? platformArtifact?.url,
    packageSha256: manifest.packageSha256 ?? platformArtifact?.sha256,
    notes: manifest.notes,
  };
}

export async function fetchUpdateManifest(url = updateManifestUrl(), fetchImpl: typeof fetch = fetch): Promise<DashouUpdateManifest> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GitHub update manifest returned HTTP ${response.status}`);
  const value = await response.json() as Partial<DashouUpdateManifest>;
  if (value.kind !== "dashou-cli" || value.packageName !== "@warmbyte/dashou") {
    throw new Error("GitHub update manifest is not a Dashou CLI manifest");
  }
  if (typeof value.version !== "string" || !isSemver(value.version)) throw new Error("GitHub update manifest has no valid version");
  if (value.packageUrl !== undefined && typeof value.packageUrl !== "string") throw new Error("GitHub update manifest has an invalid package URL");
  if (value.packageSha256 !== undefined && !isSha256(value.packageSha256)) throw new Error("GitHub update manifest has an invalid package SHA-256");
  if (value.packageUrl && !isTrustedPackageUrl(value.packageUrl)) throw new Error("GitHub update manifest package URL is not trusted");
  if (value.platforms !== undefined && !isPlatformMap(value.platforms)) throw new Error("GitHub update manifest has invalid platform entries");
  return value as DashouUpdateManifest;
}

export function isTrustedPackageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
  if (url.hostname === TRUSTED_NPM_REGISTRY_HOST) {
    return new RegExp(`^/@warmbyte/dashou/-/dashou-v?${SEMVER_PATTERN}\\.tgz$`).test(url.pathname);
  }
  return url.href.startsWith(TRUSTED_GITHUB_RELEASE_PREFIX)
    && new RegExp(`/dashou-cli-v?${SEMVER_PATTERN}\\.tgz$`).test(url.pathname);
}

export async function downloadAndVerifyPackage(
  url: string,
  expectedSha256: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  if (!isTrustedPackageUrl(url)) throw new Error("Update package URL is not trusted");
  if (!isSha256(expectedSha256)) throw new Error("Update package SHA-256 is required");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Dashou update package returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error("Dashou update package is too large");
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256.toLowerCase()) throw new Error("Dashou update package SHA-256 does not match the manifest");
  return bytes;
}

export async function installCliUpdate(
  check: DashouUpdateCheck,
  execFileImpl: typeof execFile = execFile,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!check.updateAvailable) throw new Error("No Dashou CLI update is available");
  if (!check.downloadUrl || !check.packageSha256) throw new Error("Dashou CLI manifest does not provide a verified package");
  const bytes = await downloadAndVerifyPackage(check.downloadUrl, check.packageSha256, fetchImpl);
  const tempDir = await mkdtemp(join(tmpdir(), "dashou-upgrade-"));
  const packagePath = join(tempDir, "dashou-cli.tgz");
  try {
    await writeFile(packagePath, bytes, { mode: 0o600 });
    await execFileImpl("npm", ["install", "--global", packagePath], { maxBuffer: 4 * 1024 * 1024 });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

const SEMVER_PATTERN = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";

function isSemver(value: string): boolean {
  return new RegExp(`^v?${SEMVER_PATTERN}$`).test(value);
}

function isPlatformMap(value: Record<string, unknown>): boolean {
  return Object.values(value).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const artifact = entry as Record<string, unknown>;
    return (artifact.url === undefined || typeof artifact.url === "string")
      && (artifact.signature === undefined || typeof artifact.signature === "string")
      && (artifact.sha256 === undefined || isSha256(artifact.sha256))
      && (!artifact.url || isTrustedPackageUrl(artifact.url));
  });
}
