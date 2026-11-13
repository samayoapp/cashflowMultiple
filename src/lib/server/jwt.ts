import { SignJWT, jwtVerify } from 'jose';

/** Compatible con Edge (middleware) y Node (route handlers). */
export const SESSION_COOKIE = 'cf_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 horas

export interface SessionClaims {
  sub: string;
  role: 'ADMIN' | 'USER';
  name: string;
}

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET no está configurado o tiene menos de 32 caracteres');
  }
  return new TextEncoder().encode(s);
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ role: claims.role, name: claims.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('cashflow-publimatec')
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: 'cashflow-publimatec',
      algorithms: ['HS256'],
    });
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      role: payload.role === 'ADMIN' ? 'ADMIN' : 'USER',
      name: String(payload.name ?? ''),
    };
  } catch {
    return null;
  }
}
