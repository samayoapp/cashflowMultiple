import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { readJson, route, ApiError } from '@/lib/server/api';
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from '@/lib/server/auth';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from '@/lib/server/jwt';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(200),
  password: z.string().min(1).max(200),
});

// Límite simple en memoria contra fuerza bruta: 10 intentos fallidos / 15 min por IP+correo
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

// Hash ficticio para igualar tiempos cuando el usuario no existe
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomUUID()));

export const POST = route(async (req) => {
  const { email, password } = schema.parse(await readJson(req, 4096));
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const key = `${ip}|${email}`;
  const now = Date.now();
  const entry = attempts.get(key);
  if (entry && entry.resetAt > now && entry.count >= MAX_ATTEMPTS) {
    throw new ApiError(429, 'Demasiados intentos. Intenta de nuevo en unos minutos.');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const valid = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

  if (!user || !valid || !user.active) {
    const e = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + WINDOW_MS };
    e.count += 1;
    attempts.set(key, e);
    throw new ApiError(401, 'Credenciales inválidas');
  }
  attempts.delete(key);

  const token = await signSession({ sub: user.id, role: user.role, name: user.name });
  const res = NextResponse.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
});
