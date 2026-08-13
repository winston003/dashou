import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DashouPilotPolicy, DashouPilotRemoteConfig } from "./dashou-pilot-policy.js";

export interface DashouUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  allowedHosts?: string[];
  publicBaseUrl?: string;
  stateDir?: string;
  pilot?: Partial<DashouPilotPolicy>;
  pilotPolicyUrl?: string;
}

export interface DashouAuthFile {
  ownerToken?: string;
  tunnelToken?: string;
  pilotToken?: string;
}

export interface DashouConfig {
  host: string;
  port: number;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  stateDir: string;
  trustProxy: boolean;
  tunnelToken?: string;
  oauth: {
    ownerToken: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    scopes: string[];
    allowedRedirectHosts: string[];
    pilot?: DashouPilotPolicy;
    pilotRemote?: DashouPilotRemoteConfig;
  };
}

export interface DashouFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: DashouUserConfig;
  auth: DashouAuthFile;
}

const DEFAULT_PORT = 7677;
const DEFAULT_ACCESS_TTL = 60 * 60;
const DEFAULT_REFRESH_TTL = 30 * 24 * 60 * 60;

export function dashouConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHome(env.DASHOU_CONFIG_DIR ?? join(homedir(), ".dashou")));
}

export function loadDashouFiles(env: NodeJS.ProcessEnv = process.env): DashouFiles {
  const dir = dashouConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);
  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJson<DashouUserConfig>(configPath) : {},
    auth: authExists ? readJson<DashouAuthFile>(authPath) : {},
  };
}

export function writeDashouConfig(config: DashouUserConfig, env: NodeJS.ProcessEnv = process.env): string {
  const filePath = join(dashouConfigDir(env), "config.json");
  writeJson(filePath, config);
  return filePath;
}

export function writeDashouAuth(auth: DashouAuthFile, env: NodeJS.ProcessEnv = process.env): string {
  const filePath = join(dashouConfigDir(env), "auth.json");
  writeJson(filePath, auth);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function loadDashouConfig(env: NodeJS.ProcessEnv = process.env): DashouConfig {
  const files = loadDashouFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = positiveInt(env.PORT ?? numberString(files.config.port), DEFAULT_PORT, "PORT", 65535);
  const publicBaseUrl = normalizeBaseUrl(
    env.DASHOU_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localBaseUrl(host, port),
  );
  const ownerToken = requiredSecret(
    env.DASHOU_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken,
    "DASHOU_OAUTH_OWNER_TOKEN",
  );
  const allowedRoots = parseRoots(env.DASHOU_ALLOWED_ROOTS, files.config.allowedRoots);
  const derivedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  return {
    host,
    port,
    allowedRoots,
    allowedHosts: parseList(env.DASHOU_ALLOWED_HOSTS, derivedHosts),
    publicBaseUrl,
    stateDir: resolve(
      expandHome(
        env.DASHOU_STATE_DIR
          ?? files.config.stateDir
          ?? join(homedir(), ".local", "share", "dashou"),
      ),
    ),
    trustProxy: bool(env.DASHOU_TRUST_PROXY),
    tunnelToken: optionalSecret(env.DASHOU_TUNNEL_TOKEN ?? files.auth.tunnelToken),
    oauth: {
      ownerToken,
      accessTokenTtlSeconds: positiveInt(
        env.DASHOU_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        DEFAULT_ACCESS_TTL,
        "DASHOU_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
      ),
      refreshTokenTtlSeconds: positiveInt(
        env.DASHOU_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
        DEFAULT_REFRESH_TTL,
        "DASHOU_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
      ),
      scopes: parseList(env.DASHOU_OAUTH_SCOPES, ["dashou"]),
      allowedRedirectHosts: parseList(env.DASHOU_OAUTH_ALLOWED_REDIRECT_HOSTS, [
        "chatgpt.com",
        "localhost",
        "127.0.0.1",
      ]),
      pilot: {
        enabled: env.DASHOU_PILOT_ENABLED === undefined
          ? files.config.pilot?.enabled ?? true
          : bool(env.DASHOU_PILOT_ENABLED),
        ...(env.DASHOU_PILOT_ACCOUNT_ID?.trim() || files.config.pilot?.accountId
          ? { accountId: env.DASHOU_PILOT_ACCOUNT_ID?.trim() || files.config.pilot?.accountId }
          : {}),
        ...(env.DASHOU_PILOT_EXPIRES_AT?.trim() || files.config.pilot?.expiresAt
          ? { expiresAt: env.DASHOU_PILOT_EXPIRES_AT?.trim() || files.config.pilot?.expiresAt }
          : {}),
      },
      ...loadPilotRemoteConfig(env, files.config),
    },
  };
}

export function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Public URL must use http or https");
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function parseRoots(envValue: string | undefined, fileValue: string[] | undefined): string[] {
  const values = envValue
    ? envValue.split(",").map((value) => value.trim()).filter(Boolean)
    : fileValue?.filter(Boolean) ?? [];
  if (values.length === 0) throw new Error("DASHOU_ALLOWED_ROOTS is required. Run: dashou init");
  return values.map((value) => resolve(expandHome(value)));
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  const entries = value?.split(",").map((entry) => entry.trim()).filter(Boolean);
  const resolved = entries?.length ? entries : fallback;
  if (resolved.includes("*")) return ["*"];
  return [...new Set(resolved)];
}

function requiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) throw new Error(`${name} is required. Run: dashou init`);
  if (secret.length < 16) throw new Error(`${name} must be at least 16 characters long`);
  return secret;
}

function optionalSecret(value: string | undefined): string | undefined {
  const secret = value?.trim();
  return secret || undefined;
}

function loadPilotRemoteConfig(
  env: NodeJS.ProcessEnv,
  fileConfig: DashouUserConfig,
): { pilotRemote?: DashouPilotRemoteConfig } {
  const urlValue = env.DASHOU_PILOT_POLICY_URL?.trim() || fileConfig.pilotPolicyUrl?.trim();
  const token = env.DASHOU_PILOT_POLICY_TOKEN?.trim();
  const publicKeyPem = env.DASHOU_PILOT_POLICY_PUBLIC_KEY?.trim();
  if (!urlValue && token) throw new Error("DASHOU_PILOT_POLICY_URL is required when DASHOU_PILOT_POLICY_TOKEN is set");
  if (!urlValue && publicKeyPem) throw new Error("DASHOU_PILOT_POLICY_URL is required when DASHOU_PILOT_POLICY_PUBLIC_KEY is set");
  if (!urlValue) return {};
  if (!token) throw new Error("DASHOU_PILOT_POLICY_TOKEN is required when DASHOU_PILOT_POLICY_URL is set");
  if (!publicKeyPem) throw new Error("DASHOU_PILOT_POLICY_PUBLIC_KEY is required when DASHOU_PILOT_POLICY_URL is set");

  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("DASHOU_PILOT_POLICY_URL must be a valid http or https URL");
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("DASHOU_PILOT_POLICY_URL must use http or https");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("DASHOU_PILOT_POLICY_URL must use https outside localhost/127.0.0.1");
  }

  const cacheTtlSeconds = positiveInt(
    env.DASHOU_PILOT_POLICY_CACHE_TTL_SECONDS,
    300,
    "DASHOU_PILOT_POLICY_CACHE_TTL_SECONDS",
    3_600,
  );
  return {
    pilotRemote: {
      url: url.href,
      token,
      publicKeyPem: publicKeyPem.replaceAll("\\n", "\n"),
      cacheTtlMs: cacheTtlSeconds * 1_000,
    },
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function positiveInt(
  value: string | number | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function bool(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function numberString(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function localBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formatted = publicHost.includes(":") && !publicHost.startsWith("[") ? `[${publicHost}]` : publicHost;
  return `http://${formatted}:${port}`;
}

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
