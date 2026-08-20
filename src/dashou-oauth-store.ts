import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

interface OAuthState {
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, PersistedAccessTokenRecord>;
  refreshTokens: Record<string, PersistedRefreshTokenRecord>;
}

const EMPTY_STATE: OAuthState = {
  clients: {},
  accessTokens: {},
  refreshTokens: {},
};
const MAX_REGISTERED_CLIENTS = 64;
const MAX_CLIENT_METADATA_BYTES = 16 * 1024;

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return allowedHosts.includes(parsed.hostname);
}

export class JsonOAuthStore {
  private readonly filePath: string;
  private state: OAuthState;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, "oauth.json");
    this.state = this.load();
    if (this.pruneExpired()) this.persist();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.state.clients[clientId];
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    if (Object.keys(this.state.clients).length >= MAX_REGISTERED_CLIENTS) {
      throw new InvalidRequestError("This Dashou server has reached its registered client limit");
    }
    if (Buffer.byteLength(JSON.stringify(client), "utf8") > MAX_CLIENT_METADATA_BYTES) {
      throw new InvalidRequestError("Client metadata is too large");
    }
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this Dashou server");
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `dashou-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };
    this.state.clients[registered.client_id] = registered;
    this.persist();
    return registered;
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    return this.validToken(this.state.accessTokens, tokenHash);
  }

  deleteAccessToken(tokenHash: string): void {
    if (delete this.state.accessTokens[tokenHash]) this.persist();
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    return this.validToken(this.state.refreshTokens, tokenHash);
  }

  deleteRefreshToken(tokenHash: string): void {
    if (delete this.state.refreshTokens[tokenHash]) this.persist();
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    if (consumedRefreshTokenHash && !this.state.refreshTokens[consumedRefreshTokenHash]) {
      return false;
    }
    if (consumedRefreshTokenHash) delete this.state.refreshTokens[consumedRefreshTokenHash];

    this.state.accessTokens[pair.accessTokenHash] = pair.accessToken;
    this.state.refreshTokens[pair.refreshTokenHash] = pair.refreshToken;
    this.persist();
    return true;
  }

  close(): void {
    // State is persisted on every mutation. Kept for the OAuth provider lifecycle contract.
  }

  private validToken<T extends PersistedAccessTokenRecord | PersistedRefreshTokenRecord>(
    records: Record<string, T>,
    tokenHash: string,
  ): T | undefined {
    const record = records[tokenHash];
    if (!record) return undefined;
    if (record.expiresAt >= Math.floor(Date.now() / 1000)) return record;
    delete records[tokenHash];
    this.persist();
    return undefined;
  }

  private load(): OAuthState {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<OAuthState>;
      return {
        clients: parsed.clients ?? {},
        accessTokens: parsed.accessTokens ?? {},
        refreshTokens: parsed.refreshTokens ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw new Error(`Unable to read OAuth state ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private pruneExpired(): boolean {
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const records of [this.state.accessTokens, this.state.refreshTokens]) {
      for (const [tokenHash, record] of Object.entries(records)) {
        if (record.expiresAt >= now) continue;
        delete records[tokenHash];
        changed = true;
      }
    }
    return changed;
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }
}

export class JsonOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: JsonOAuthStore,
    private readonly allowedRedirectHosts: string[],
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.store.getClient(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    return this.store.registerClient(client, this.allowedRedirectHosts);
  }
}
