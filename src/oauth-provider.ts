import { timingSafeEqual, randomBytes, randomUUID, createHash } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AccessDeniedError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { JsonOAuthClientsStore, JsonOAuthStore } from "./dashou-oauth-store.js";
import { createPilotAccessGate, type DashouPilotAccessGate, type DashouPilotPolicy } from "./dashou-pilot-policy.js";
import { markConnectionMilestone } from "./connection-milestones.js";

export interface OAuthConfig {
  ownerToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
  pilot?: DashouPilotPolicy;
  pilotRemote?: import("./dashou-pilot-policy.js").DashouPilotRemoteConfig;
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
}): string {
  const resourceText = params.resource?.href ?? "这台电脑上的搭手";
  const error = params.error
    ? `<p class="error">${htmlEscape(params.error)}</p>`
    : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>连接搭手</title>
    <style>
      :root { color: #302a25; background: #f6f1e8; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; background: radial-gradient(circle at 100% 0, #fffaf2 0, #f6f1e8 48%, #eee6da 100%); }
      main { max-width: 520px; margin: 7vh auto; padding: 30px; background: rgba(255,255,255,.9); border: 1px solid #e3d8ca; border-radius: 20px; box-shadow: 0 24px 70px rgba(82,58,34,.12); }
      .eyebrow { margin: 0 0 8px; color: #a56b40; font-size: 12px; font-weight: 800; letter-spacing: .12em; }
      h1 { margin: 0; font-family: Georgia, serif; font-size: 30px; font-weight: 500; }
      p { margin: 9px 0 0; color: #766b61; line-height: 1.65; }
      ol { margin: 20px 0 0; padding: 16px 18px 16px 38px; border-radius: 14px; background: #fbf5ed; color: #5d5147; line-height: 1.9; }
      dl { margin: 16px 0 0; padding: 13px 15px; border: 1px solid #eadfd2; border-radius: 12px; background: #fffdfa; }
      dt { color: #9a8b7d; font-size: 12px; }
      dd { margin: 3px 0 9px; overflow: hidden; color: #51463d; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
      label { display: block; margin: 20px 0 8px; font-weight: 700; }
      input { width: 100%; padding: 13px 14px; border: 1px solid #cfbba9; border-radius: 10px; background: #fff; color: #302a25; font-size: 17px; }
      input:focus { border-color: #9b6339; outline: 3px solid rgba(155,99,57,.14); }
      button { width: 100%; margin-top: 14px; padding: 13px 14px; border: 0; border-radius: 10px; background: #9b6339; color: #fff; cursor: pointer; font-weight: 800; }
      .error { padding: 10px 12px; border: 1px solid #e7b8ac; border-radius: 10px; background: #fff3ef; color: #9a493b; }
      .trust { margin-top: 16px; padding-top: 14px; border-top: 1px solid #eee4d8; color: #8a7d70; font-size: 12px; }
      @media (max-width: 600px) { main { margin: 0; min-height: 100vh; padding: 24px 20px; border: 0; border-radius: 0; } }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">连接 ChatGPT · 最后一步</p>
      <h1>还差一次确认</h1>
      <p>这页正在等待搭手客户端里的授权密码，不需要填写其他信息。</p>
      ${error}
      <ol>
        <li>回到搭手客户端</li>
        <li>点击“复制授权密码”</li>
        <li>回到本页粘贴，然后允许连接</li>
      </ol>
      <dl>
        <dt>正在连接</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>连接到</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post">
${hiddenFields}
        <label for="owner_token">授权密码</label>
        <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required placeholder="粘贴从搭手复制的密码" />
        <button type="submit">允许连接</button>
      </form>
      <p class="trust">文件读取和修改仅限你选择的文件夹。运行项目命令时会使用你当前电脑账户的权限。</p>
    </main>
  </body>
</html>`;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  return requested.every((scope) => supported.includes(scope));
}

function setAuthorizationPageHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly oauthStore: JsonOAuthStore;
  private readonly resourceServerUrl: URL;
  private readonly pilotGate: DashouPilotAccessGate;
  private readonly stateDir: string;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir: string,
    pilotGate?: DashouPilotAccessGate,
  ) {
    this.stateDir = stateDir;
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.oauthStore = new JsonOAuthStore(stateDir);
    this.clientsStore = new JsonOAuthClientsStore(this.oauthStore, config.allowedRedirectHosts);
    this.pilotGate = pilotGate ?? createPilotAccessGate(config.pilot, config.pilotRemote, { stateDir });
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const access = this.pilotGate.status();
    if (!access.allowed) throw new AccessDeniedError(`搭手试用不可用：${access.reason}`);
    if (!params.resource || !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!requestedScopesAllowed(params.scopes ?? [], this.config.scopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }

    if (res.req.method !== "POST") {
      markConnectionMilestone(this.stateDir, "authorization-requested");
      res.status(200);
      setAuthorizationPageHeaders(res);
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const providedToken = String(res.req.body?.owner_token ?? "");
    if (!safeEquals(providedToken, this.config.ownerToken)) {
      res.status(401);
      setAuthorizationPageHeaders(res);
      res.send(
        formHtml({
          error: "连接密码不正确。",
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
      params,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    this.requirePilotAccess();
    const record = this.validCodeRecord(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.requirePilotAccess();
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    this.codes.delete(authorizationCode);
    const tokens = this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource);
    markConnectionMilestone(this.stateDir, "oauth-completed");
    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.requirePilotAccess();
    const refreshTokenHash = hashToken(refreshToken);
    const record = this.oauthStore.getRefreshToken(refreshTokenHash);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    }

    return this.issueTokens(
      client.client_id,
      requestedScopes,
      resource ?? (record.resource ? new URL(record.resource) : undefined),
      refreshTokenHash,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.requirePilotAccess(InvalidTokenError);
    const record = this.oauthStore.getAccessToken(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hashed = hashToken(request.token);
    this.oauthStore.deleteAccessToken(hashed);
    this.oauthStore.deleteRefreshToken(hashed);
  }

  close(): void {
    this.oauthStore.close();
  }

  private requirePilotAccess(
    ErrorType: typeof AccessDeniedError | typeof InvalidTokenError = AccessDeniedError,
  ): void {
    const access = this.pilotGate.status();
    if (!access.allowed) {
      throw new ErrorType(`搭手试用不可用：${access.reason}`);
    }
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: URL,
    consumedRefreshTokenHash?: string,
  ): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;

    const saved = this.oauthStore.saveTokenPair(
      {
        accessTokenHash: hashToken(accessToken),
        accessToken: {
          clientId,
          scopes,
          expiresAt: accessExpiresAt,
          resource: resource?.href,
        },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: {
          clientId,
          scopes,
          expiresAt: refreshExpiresAt,
          resource: resource?.href,
        },
      },
      consumedRefreshTokenHash,
    );
    if (!saved) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
