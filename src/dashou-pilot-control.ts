import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Request, Response } from "express";
import { createSignedLeaseForNode, type DashouPilotLeasePayload } from "./dashou-pilot-policy.js";

export interface DashouPilotAccountSummary {
  accountId: string;
  enabled: boolean;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

interface DashouPilotAccountRecord extends DashouPilotAccountSummary {
  tokenHash: string;
}

interface PilotControlState {
  accounts: Record<string, DashouPilotAccountRecord>;
}

export interface CreatedDashouPilotAccount {
  accountId: string;
  token: string;
  enabled: boolean;
  expiresAt: string;
}

export interface DashouPilotPolicyResponse {
  accountId: string;
  enabled: boolean;
  expiresAt: string;
}

export interface DashouPilotSignedLeaseResponse {
  lease: string;
}

const EMPTY_STATE: PilotControlState = { accounts: {} };

export class DashouPilotControlStore {
  private readonly filePath: string;
  private state: PilotControlState;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, "pilot-control.json");
    this.state = this.load();
  }

  createAccount(accountId: string, expiresAt: string, enabled = true): CreatedDashouPilotAccount {
    validateAccountId(accountId);
    validateExpiry(expiresAt);
    if (this.state.accounts[accountId]) throw new Error(`Pilot account already exists: ${accountId}`);

    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    this.state.accounts[accountId] = {
      accountId,
      enabled,
      expiresAt,
      createdAt: now,
      tokenHash: hashToken(token),
    };
    this.persist();
    return { accountId, token, enabled, expiresAt };
  }

  listAccounts(): DashouPilotAccountSummary[] {
    return Object.values(this.state.accounts)
      .map(({ tokenHash: _tokenHash, ...summary }) => summary)
      .sort((left, right) => left.accountId.localeCompare(right.accountId));
  }

  getAccount(accountId: string): DashouPilotAccountSummary | undefined {
    const account = this.state.accounts[accountId];
    if (!account) return undefined;
    const { tokenHash: _tokenHash, ...summary } = account;
    return summary;
  }

  setEnabled(accountId: string, enabled: boolean): DashouPilotAccountSummary {
    const account = this.requireAccount(accountId);
    if (account.revokedAt) throw new Error(`Pilot account is revoked: ${accountId}`);
    account.enabled = enabled;
    this.persist();
    return this.summary(account);
  }

  setExpiresAt(accountId: string, expiresAt: string): DashouPilotAccountSummary {
    validateExpiry(expiresAt);
    const account = this.requireAccount(accountId);
    if (account.revokedAt) throw new Error(`Pilot account is revoked: ${accountId}`);
    account.expiresAt = expiresAt;
    this.persist();
    return this.summary(account);
  }

  revoke(accountId: string): DashouPilotAccountSummary {
    const account = this.requireAccount(accountId);
    account.enabled = false;
    account.revokedAt ??= new Date().toISOString();
    this.persist();
    return this.summary(account);
  }

  policyForToken(token: string, now = Date.now()): DashouPilotPolicyResponse | undefined {
    const tokenHash = hashToken(token);
    const account = Object.values(this.state.accounts).find((candidate) => safeEquals(candidate.tokenHash, tokenHash));
    if (!account || account.revokedAt) return undefined;
    return {
      accountId: account.accountId,
      enabled: account.enabled && Date.parse(account.expiresAt) > now,
      expiresAt: account.expiresAt,
    };
  }

  private requireAccount(accountId: string): DashouPilotAccountRecord {
    const account = this.state.accounts[accountId];
    if (!account) throw new Error(`Pilot account not found: ${accountId}`);
    return account;
  }

  private summary(account: DashouPilotAccountRecord): DashouPilotAccountSummary {
    const { tokenHash: _tokenHash, ...summary } = account;
    return summary;
  }

  private load(): PilotControlState {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PilotControlState>;
      return { accounts: parsed.accounts ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw new Error(`Unable to read pilot control state ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }
}

export interface DashouPilotControlRouterOptions {
  store: DashouPilotControlStore;
  adminToken: string;
  leasePrivateKeyPem: string;
  leaseTtlSeconds?: number;
}

/**
 * Small control-plane surface for an internal pilot. It is intentionally
 * separate from the five MCP tools and stores account tokens only as hashes.
 */
export function registerPilotControlRoutes(
  app: { get(path: string, handler: (request: Request, response: Response) => unknown): unknown; post(path: string, handler: (request: Request, response: Response) => unknown): unknown },
  options: DashouPilotControlRouterOptions,
): void {
  app.get("/pilot-policy", (request, response) => {
    const token = bearerToken(request);
    const policy = token ? options.store.policyForToken(token) : undefined;
    if (!policy) {
      response.status(401).json({ error: "Invalid pilot account token" });
      return;
    }
    const accountExpiry = Date.parse(policy.expiresAt);
    const leaseExpiry = policy.enabled
      ? Math.min(accountExpiry, Date.now() + (options.leaseTtlSeconds ?? 15 * 60) * 1_000)
      : Date.now() + (options.leaseTtlSeconds ?? 15 * 60) * 1_000;
    const payload: DashouPilotLeasePayload = {
      accountId: policy.accountId,
      enabled: policy.enabled,
      expiresAt: new Date(leaseExpiry).toISOString(),
      issuedAt: new Date().toISOString(),
    };
    response.json({ lease: createSignedLeaseForNode(payload, options.leasePrivateKeyPem) });
  });

  app.get("/admin/pilot/accounts", (request, response) => {
    if (!adminAuthorized(request, options.adminToken)) {
      response.status(401).json({ error: "Invalid pilot admin token" });
      return;
    }
    response.json({ accounts: options.store.listAccounts() });
  });

  app.post("/admin/pilot/accounts", (request, response) => {
    if (!adminAuthorized(request, options.adminToken)) {
      response.status(401).json({ error: "Invalid pilot admin token" });
      return;
    }
    try {
      const body = asObject(request.body);
      const accountId = requiredString(body.accountId, "accountId");
      const expiresAt = requiredString(body.expiresAt, "expiresAt");
      const enabled = body.enabled === undefined ? true : requiredBoolean(body.enabled, "enabled");
      const created = options.store.createAccount(accountId, expiresAt, enabled);
      response.status(201).json(created);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/admin/pilot/accounts/:accountId", (request, response) => {
    if (!adminAuthorized(request, options.adminToken)) {
      response.status(401).json({ error: "Invalid pilot admin token" });
      return;
    }
    try {
      const body = asObject(request.body);
      const accountId = routeParameter(request.params.accountId, "accountId");
      let account = options.store.getAccount(accountId);
      if (!account) throw new Error(`Pilot account not found: ${accountId}`);
      if (body.revoke === true) account = options.store.revoke(accountId);
      if (body.enabled !== undefined) account = options.store.setEnabled(accountId, requiredBoolean(body.enabled, "enabled"));
      if (body.expiresAt !== undefined) account = options.store.setExpiresAt(accountId, requiredString(body.expiresAt, "expiresAt"));
      response.json(account);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });
}

function bearerToken(request: Request): string | undefined {
  const header = request.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

function adminAuthorized(request: Request, adminToken: string): boolean {
  const presented = bearerToken(request);
  return Boolean(presented && safeEquals(presented, adminToken));
}

function safeEquals(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function validateAccountId(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(value)) {
    throw new Error("accountId must be 2-64 characters using letters, numbers, dot, underscore or hyphen");
  }
}

function validateExpiry(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("expiresAt must be an ISO-8601 date-time");
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function routeParameter(value: string | string[] | undefined, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
