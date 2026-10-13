import { createHmac, timingSafeEqual } from 'crypto';

export type JwtClaims = Record<string, unknown> & { exp?: number; nbf?: number };

/** JWT claim that carries the tenant (gherkin-ai.config.json security.tenantClaim). */
export const TENANT_CLAIM = "tenant_id";

const fromBase64Url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const toBase64Url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function parse(part: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fromBase64Url(part).toString('utf8'));
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Claims of a valid HS256 token signed with `secret` (signature, exp and nbf checked), else undefined. */
export function verifyJwt(token: string, secret: string, nowSeconds = Date.now() / 1000): JwtClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !secret) return undefined;
  if (parse(parts[0])?.alg !== 'HS256') return undefined;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = fromBase64Url(parts[2]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  const claims = parse(parts[1]) as JwtClaims | undefined;
  if (!claims) return undefined;
  if (typeof claims.exp === 'number' && nowSeconds >= claims.exp) return undefined;
  if (typeof claims.nbf === 'number' && nowSeconds < claims.nbf) return undefined;
  return claims;
}

/** Signs an HS256 token (tests and local tooling; production tokens come from your identity provider). */
export function signJwt(claims: JwtClaims, secret: string): string {
  const head = toBase64Url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = toBase64Url(Buffer.from(JSON.stringify(claims)));
  const sig = toBase64Url(createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

/**
 * Tenant of a request: the TENANT_CLAIM of its validated Bearer token. Undefined when the token is
 * missing, invalid or has no tenant. Headers such as X-Tenant-Id are never trusted.
 */
export function tenantFromAuthorization(authorization: string | undefined, secret = process.env.JWT_SECRET ?? ''): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  if (!match) return undefined;
  const claims = verifyJwt(match[1].trim(), secret);
  const tenant = claims?.[TENANT_CLAIM];
  return typeof tenant === 'string' && tenant.trim() ? tenant : undefined;
}
