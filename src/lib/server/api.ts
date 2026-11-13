import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new ApiError(400, m);
export const unauthorized = (m = 'No autenticado') => new ApiError(401, m);
export const forbidden = (m = 'Sin acceso a este recurso') => new ApiError(403, m);
export const notFound = (m = 'No encontrado') => new ApiError(404, m);
export const conflict = (m: string) => new ApiError(409, m);

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Envuelve un Route Handler: traduce errores a respuestas JSON consistentes. */
export function route<C = { params: Record<string, string> }>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      if (err instanceof ZodError) {
        const issue = err.issues[0];
        const path = issue?.path.join('.') || 'body';
        return NextResponse.json(
          { error: `Dato inválido en "${path}": ${issue?.message ?? 'formato incorrecto'}` },
          { status: 400 },
        );
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002') return NextResponse.json({ error: 'Registro duplicado' }, { status: 409 });
        if (err.code === 'P2025') return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
        if (err.code === 'P2003')
          return NextResponse.json({ error: 'El registro está en uso por otros datos' }, { status: 409 });
      }
      if (err instanceof SyntaxError) {
        return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
      }
      console.error('[api] Error no controlado:', err);
      return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 });
    }
  };
}

export const ok = <T>(data: T, init?: ResponseInit) => NextResponse.json(data, init);

export async function readJson(req: Request, maxBytes = 256 * 1024): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new ApiError(413, 'Cuerpo de la solicitud demasiado grande');
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError(413, 'Cuerpo de la solicitud demasiado grande');
  return text ? JSON.parse(text) : {};
}
