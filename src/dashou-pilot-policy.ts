import { createPublicKey, sign as signSignature, verify as verifySignature, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DashouPilotPolicy {
  enabled: boolean;
  accountId?: string;
  expiresAt?: string;
}

export interface DashouPilotRemoteConfig {
  url: string;
  token: string;
  publicKeyPem: string;
  cacheTtlMs: number;
  stateDir?: string;
}

export interface DashouPilotLeasePayload {
  accountId: string;
  enabled: boolean;
  expiresAt: string;
  issuedAt: string;
}

export interface DashouPilotSignedLeaseResponse {
  lease: string;
}

export interface DashouPilotAccessStatus {
  allowed: boolean;
  reason:
    | "enabled"
    | "disabled"
    | "expired"
    | "invalid-expiry"
    | "remote-unavailable"
    | "invalid-remote-policy";
  accountId?: string;
  expiresAt?: string;
}

export function pilotAccessStatus(policy: DashouPilotPolicy | undefined, now = Date.now()): DashouPilotAccessStatus {
  const effective = policy ?? { enabled: true };
  if (!effective.enabled) return { allowed: false, reason: "disabled", ...publicPolicyFields(effective) };
  if (!effective.expiresAt) return { allowed: true, reason: "enabled", ...publicPolicyFields(effective) };
  const expiry = Date.parse(effective.expiresAt);
  if (!Number.isFinite(expiry)) return { allowed: false, reason: "invalid-expiry", ...publicPolicyFields(effective) };
  if (expiry <= now) return { allowed: false, reason: "expired", ...publicPolicyFields(effective) };
  return { allowed: true, reason: "enabled", ...publicPolicyFields(effective) };
}

function publicPolicyFields(policy: DashouPilotPolicy): Pick<DashouPilotAccessStatus, "accountId" | "expiresAt"> {
  return {
    ...(policy.accountId ? { accountId: policy.accountId } : {}),
    ...(policy.expiresAt ? { expiresAt: policy.expiresAt } : {}),
  };
}

export interface DashouPilotAccessGate {
  /** A local-only operation. It must never perform network I/O. */
  status(): DashouPilotAccessStatus;
  /** Fetch and verify a new lease. Background callers should handle failures. */
  refresh(): Promise<DashouPilotAccessStatus>;
  /** Start periodic refreshes; the initial refresh is intentionally asynchronous. */
  start(): void;
  stop(): void;
  invalidate(): void;
}

interface StoredLease {
  signedLease: string;
}

interface PilotGateOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  stateDir?: string;
}

const LEASE_FILE = "pilot-lease.json";
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

/**
 * The remote control plane is an entitlement issuer, not a request-time
 * dependency. Every status check verifies only local policy plus the cached
 * signed lease. Network work happens only in refresh(), which is started in
 * the background by the server.
 */
export function createPilotAccessGate(
  localPolicy: DashouPilotPolicy | undefined,
  remote: DashouPilotRemoteConfig | undefined,
  options: PilotGateOptions = {},
): DashouPilotAccessGate {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const leasePath = remote?.stateDir || options.stateDir ? join(remote?.stateDir ?? options.stateDir!, LEASE_FILE) : undefined;
  let signedLease = loadStoredLease(leasePath);
  let leasePayload = signedLease && remote ? verifySignedLease(signedLease, remote.publicKeyPem, now()) : undefined;
  let refreshPromise: Promise<DashouPilotAccessStatus> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const localStatus = (): DashouPilotAccessStatus => pilotAccessStatus(localPolicy, now());

  const status = (): DashouPilotAccessStatus => {
    const local = localStatus();
    if (!local.allowed || !remote) return local;
    if (!leasePayload) return { allowed: false, reason: "remote-unavailable" };

    const remoteStatus = pilotAccessStatus(leasePayload, now());
    if (!remoteStatus.allowed) return remoteStatus;
    const expiresAt = earliestExpiry(local.expiresAt, leasePayload.expiresAt);
    const effective = pilotAccessStatus({
      enabled: true,
      accountId: leasePayload.accountId || local.accountId,
      ...(expiresAt ? { expiresAt } : {}),
    }, now());
    return {
      ...effective,
      ...(leasePayload.accountId || local.accountId
        ? { accountId: leasePayload.accountId || local.accountId }
        : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  };

  const refresh = async (): Promise<DashouPilotAccessStatus> => {
    if (!remote) return localStatus();
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const response = await fetchRemotePilotLease(remote, fetchImpl);
        const verified = verifySignedLease(response.lease, remote.publicKeyPem, now());
        if (!verified) throw new InvalidRemotePilotPolicyError("Pilot lease signature or payload was invalid");
        signedLease = response.lease;
        leasePayload = verified;
        saveStoredLease(leasePath, response.lease);
        return status();
      } catch (error) {
        if (error instanceof RevokedRemotePilotLeaseError) {
          signedLease = undefined;
          leasePayload = undefined;
          removeStoredLease(leasePath);
        }
        const existing = status();
        if (existing.allowed) return existing;
        return {
          allowed: false,
          reason: error instanceof InvalidRemotePilotPolicyError ? "invalid-remote-policy" : "remote-unavailable",
        };
      } finally {
        refreshPromise = undefined;
      }
    })();
    return refreshPromise;
  };

  return {
    status,
    refresh,
    start(): void {
      if (!remote || refreshTimer) return;
      // A valid cached lease is sufficient for an offline-capable restart.
      // Refresh it on the normal timer instead of making startup perform
      // network I/O, even in the background.
      if (!status().allowed) void refresh();
      refreshTimer = setInterval(() => { void refresh(); }, remote.cacheTtlMs);
      refreshTimer.unref?.();
    },
    stop(): void {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
    },
    invalidate(): void {
      signedLease = undefined;
      leasePayload = undefined;
      removeStoredLease(leasePath);
    },
  };
}

class InvalidRemotePilotPolicyError extends Error {}
class RevokedRemotePilotLeaseError extends Error {}

async function fetchRemotePilotLease(
  remote: DashouPilotRemoteConfig,
  fetchImpl: typeof fetch,
): Promise<DashouPilotSignedLeaseResponse> {
  const response = await fetchImpl(remote.url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${remote.token}`,
    },
    signal: AbortSignal.timeout(Math.min(remote.cacheTtlMs, 30_000)),
  });
  if (response.status === 401 || response.status === 403) throw new RevokedRemotePilotLeaseError("Pilot lease was rejected");
  if (!response.ok) throw new Error(`Pilot policy returned HTTP ${response.status}`);

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new InvalidRemotePilotPolicyError("Pilot policy was not valid JSON");
  }
  if (!isSignedLeaseResponse(value)) {
    throw new InvalidRemotePilotPolicyError("Pilot policy did not match the signed lease contract");
  }
  return value;
}

function isSignedLeaseResponse(value: unknown): value is DashouPilotSignedLeaseResponse {
  return Boolean(value && typeof value === "object" && typeof (value as { lease?: unknown }).lease === "string");
}

export function verifySignedLease(
  signedLease: string,
  publicKeyPem: string,
  now = Date.now(),
): DashouPilotLeasePayload | undefined {
  const separator = signedLease.lastIndexOf(".");
  if (separator <= 0 || separator === signedLease.length - 1) return undefined;
  const encodedPayload = signedLease.slice(0, separator);
  const encodedSignature = signedLease.slice(separator + 1);
  if (!isBase64Url(encodedPayload) || !isBase64Url(encodedSignature)) return undefined;

  let payload: unknown;
  let signature: Buffer;
  try {
    const payloadBytes = Buffer.from(encodedPayload, "base64url");
    if (payloadBytes.toString("base64url") !== encodedPayload) return undefined;
    payload = JSON.parse(payloadBytes.toString("utf8"));
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return undefined;
  }
  if (!isLeasePayload(payload)) return undefined;

  let key: KeyObject;
  try {
    key = createPublicKey(normalizePem(publicKeyPem));
  } catch {
    return undefined;
  }
  const valid = verifySignature(
    "RSA-SHA256",
    Buffer.from(encodedPayload, "ascii"),
    { key, padding: 6, saltLength: 32 },
    signature,
  );
  if (!valid) return undefined;

  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return undefined;
  if (issuedAt > now + CLOCK_SKEW_MS || expiresAt <= issuedAt) return undefined;
  return payload;
}

export function createSignedLeaseForNode(
  payload: DashouPilotLeasePayload,
  privateKeyPem: string,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signSignature(
    "RSA-SHA256",
    Buffer.from(encodedPayload, "ascii"),
    { key: normalizePem(privateKeyPem), padding: 6, saltLength: 32 },
  );
  return `${encodedPayload}.${signature.toString("base64url")}`;
}

function isLeasePayload(value: unknown): value is DashouPilotLeasePayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.accountId === "string"
    && candidate.accountId.length > 0
    && typeof candidate.enabled === "boolean"
    && typeof candidate.expiresAt === "string"
    && typeof candidate.issuedAt === "string";
}

function earliestExpiry(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function loadStoredLease(filePath: string | undefined): string | undefined {
  if (!filePath || !existsSync(filePath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as StoredLease;
    return typeof value.signedLease === "string" ? value.signedLease : undefined;
  } catch {
    return undefined;
  }
}

function saveStoredLease(filePath: string | undefined, signedLease: string): void {
  if (!filePath) return;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify({ signedLease }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tempPath, filePath);
}

function removeStoredLease(filePath: string | undefined): void {
  if (!filePath) return;
  try { unlinkSync(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
}

function normalizePem(value: string): string {
  return value.trim().replaceAll("\\n", "\n");
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
