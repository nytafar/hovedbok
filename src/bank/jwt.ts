// Enable Banking application JWT (API reference, "JWT format and signature"):
// header {typ: JWT, alg: RS256, kid: <app id>}, claims {iss: enablebanking.com,
// aud: api.enablebanking.com, iat, exp}. Signed with the application's RSA
// private key through node:crypto — both PKCS#1 ("BEGIN RSA PRIVATE KEY") and
// PKCS#8 ("BEGIN PRIVATE KEY") PEMs, which is what the Control Panel hands out.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

export const JWT_ISSUER = "enablebanking.com";
export const JWT_AUDIENCE = "api.enablebanking.com";
/** Under Enable Banking's 24 h cap; short so a leaked token is worth little. */
export const JWT_TTL_SECONDS = 3600;

function b64url(data: Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return buf.toString("base64url");
}

export interface JwtOptions {
  /** Seconds since the epoch; defaults to now. */
  iat?: number;
  ttlSeconds?: number;
}

/** Parses a PEM private key once; throws early on a key that cannot sign. */
export function loadPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(`Enable Banking key must be RSA, got ${key.asymmetricKeyType}`);
  }
  return key;
}

/** Mints a signed application token. */
export function signJwt(appId: string, key: KeyObject, opts: JwtOptions = {}): string {
  if (!appId) throw new Error("Enable Banking application id is empty");
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? JWT_TTL_SECONDS;
  if (ttl <= 0 || ttl > 86400) throw new Error(`JWT ttl ${ttl}s outside (0, 86400]`);
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const claims = b64url(
    JSON.stringify({ iss: JWT_ISSUER, aud: JWT_AUDIENCE, iat, exp: iat + ttl }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), key);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** Caches a token and re-mints it before expiry. */
export function tokenSource(
  appId: string,
  key: KeyObject,
  ttlSeconds = JWT_TTL_SECONDS,
  now: () => number = () => Date.now(),
): () => string {
  let token: string | undefined;
  let exp = 0;
  const refreshBefore = Math.min(600, Math.floor(ttlSeconds / 2));
  return () => {
    const t = Math.floor(now() / 1000);
    if (!token || t >= exp - refreshBefore) {
      token = signJwt(appId, key, { iat: t, ttlSeconds });
      exp = t + ttlSeconds;
    }
    return token;
  };
}
