import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE_NAME = "tapo_access";
export const ACCESS_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

function safeEqualStrings(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a, "utf8").digest();
  const hashB = createHash("sha256").update(b, "utf8").digest();
  const digestsEqual = timingSafeEqual(hashA, hashB);
  return digestsEqual && a.length === b.length;
}

function deriveHmacKey(password: string): Buffer {
  return createHash("sha256").update(`tapo-admin-gate:${password}`, "utf8").digest();
}

export function parseCookieHeader(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Formats the `Set-Cookie` header for `tapo_access`, adding `Secure` only on HTTPS requests
 * so local HTTP (`http://127.0.0.1`) continues to work.
 */
export function buildAccessCookie(req: Request, value: string, maxAgeSec: number): string {
  const isHttps = (() => {
    try {
      if (new URL(req.url).protocol === "https:") return true;
    } catch {
      // ignore invalid URL
    }
    const forwardedProto = req.headers
      .get("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim()
      .toLowerCase();
    return forwardedProto === "https";
  })();

  const parts = [
    `${ACCESS_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  if (isHttps) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export interface AccessGuard {
  readonly required: boolean;
  verifyPassword: (candidate: string) => boolean;
  issueCookieHeader: (req: Request) => string;
  clearCookieHeader: (req: Request) => string;
  isRequestAuthorized: (req: Request) => boolean;
}

/**
 * Creates an optional password guard for remote deployments.
 * Cookies use HMAC-SHA256 tokens derived from the configured password so they survive restarts.
 */
export function createAccessGuard(configuredPassword?: string): AccessGuard {
  const password =
    configuredPassword && configuredPassword.trim().length > 0 ? configuredPassword : "";
  if (!password) {
    return {
      required: false,
      verifyPassword: () => true,
      issueCookieHeader: (req) => buildAccessCookie(req, "", 0),
      clearCookieHeader: (req) => buildAccessCookie(req, "", 0),
      isRequestAuthorized: () => true,
    };
  }

  const key = deriveHmacKey(password);

  const signToken = (nowMs = Date.now()): string => {
    const issuedAtHex = Math.floor(nowMs / 1000).toString(16);
    const sigHex = createHmac("sha256", key).update(issuedAtHex, "utf8").digest("hex");
    return `${issuedAtHex}.${sigHex}`;
  };

  const verifyToken = (token: string, nowMs = Date.now()): boolean => {
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [issuedAtHex, sigHex] = parts;
    if (!issuedAtHex || !sigHex || !/^[0-9a-f]+$/i.test(issuedAtHex)) {
      return false;
    }
    const issuedAtSec = Number.parseInt(issuedAtHex, 16);
    if (!Number.isFinite(issuedAtSec)) return false;

    const ageSec = Math.floor(nowMs / 1000) - issuedAtSec;
    if (ageSec < -60 || ageSec > ACCESS_COOKIE_MAX_AGE_SEC) {
      return false;
    }

    const expectedHex = createHmac("sha256", key).update(issuedAtHex, "utf8").digest("hex");
    const sigBuf = Buffer.from(sigHex, "utf8");
    const expectedBuf = Buffer.from(expectedHex, "utf8");
    if (sigBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(sigBuf, expectedBuf);
  };

  const verifyPassword = (candidate: string): boolean => {
    if (!candidate) return false;
    return safeEqualStrings(candidate, password);
  };

  const isRequestAuthorized = (req: Request): boolean => {
    const cookieToken = parseCookieHeader(req.headers.get("cookie"), ACCESS_COOKIE_NAME);
    if (cookieToken && verifyToken(cookieToken)) {
      return true;
    }

    const authHeader = req.headers.get("authorization");
    if (authHeader) {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match && verifyPassword(match[1]!.trim())) {
        return true;
      }
    }

    return false;
  };

  return {
    required: true,
    verifyPassword,
    issueCookieHeader: (req) => buildAccessCookie(req, signToken(), ACCESS_COOKIE_MAX_AGE_SEC),
    clearCookieHeader: (req) => buildAccessCookie(req, "", 0),
    isRequestAuthorized,
  };
}
