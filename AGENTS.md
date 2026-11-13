# Reglas del proyecto (para asistentes y colaboradores)

## 1. Producción
- **El asistente NO ejecuta comandos SSH hacia el servidor de producción** ni corre `./deploy.sh`.
  Allan ejecuta el despliegue manualmente.
- El asistente solo trabaja en el código local, hace commits y (cuando se le pide) push a GitHub (`origin master`).

## 2. Protección de la base de datos
- **Nunca** usar `prisma db push` ni `prisma migrate reset` en arranque, scripts o producción.
- Los cambios de esquema se hacen con un **nuevo** archivo SQL idempotente en `prisma/migrations/NNN_descripcion.sql`
  (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
  bloques `DO $$ ... EXCEPTION WHEN duplicate_object`), y se refleja el mismo cambio en `prisma/schema.prisma`.
- Prohibido `DROP`, `TRUNCATE` o `DELETE` masivo en migraciones y seeds. Los seeds solo agregan datos.
- `deploy.sh` hace un `pg_dump` obligatorio antes de tocar nada.

## 3. Dinero y fechas
- Montos: `NUMERIC(18,2)` en la base, **centavos enteros** en el motor y la UI (`src/lib/money.ts`). Nunca `float`.
- Fechas de tesorería: `DATE` / strings `YYYY-MM-DD` (`src/lib/dates.ts`).
- Toda lógica de proyección vive en `src/lib/projection/` (funciones puras) y debe tener pruebas en Vitest.

## 4. Aislamiento por entidad
- Toda consulta de datos operativos pasa por `src/lib/server/scope.ts` (`resolveContext`, `assertEntityAccess`).

## 5. Secretos
- Nada de secretos en el código ni en `docker-compose.yml`: todo va en `.env` (ignorado por Git).
