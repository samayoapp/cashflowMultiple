# Cashflow Publimatec

Tesorería operativa y flujo de efectivo proyectado **multi‑entidad** (inspirado en Float / Pulse / Dryrun).
No es un ERP ni contabilidad devengada: muestra la liquidez real de hoy y la proyecta a 13 semanas y 90 días.

**Stack (igual a CRM Publimatec):** Next.js 14.2 (App Router) · React 18 · TypeScript · Tailwind 3.4 ·
Prisma 5 · PostgreSQL 16 · JWT (`jose`) en cookie HttpOnly · `bcryptjs` · Docker Compose (2 contenedores).
Extras: Recharts (gráfica), zod (validación), Vitest (pruebas del motor).

## Funcionalidades

- **Multi‑entidad:** Entidad Base creada automáticamente, entidades ilimitadas, datos aislados y vista consolidada con color por origen.
- **Dashboard:** caja real hoy, flujo neto 30 días, runway, punto más bajo de caja a 90 días con alertas; gráfica de 13 semanas (barras apiladas por entidad, saldo proyectado y umbral); desglose por origen; radar de acción (CxC vencidas y CxP inamovibles de los próximos 7 días).
- **Matriz de flujo:** tabla semanal o mensual con saldo inicial, entradas, salidas y cierre. Edición en línea de montos y cambio de semana con recálculo instantáneo.
- **CxC / CxP:** doble fecha (vencimiento contractual y fecha esperada), arrastre automático de vencidos, abonos parciales, prioridades inamovible o flexible, recurrencias y transferencias inter‑entidad neteadas en el consolidado.
- **Simulación (What‑If):** partidas hipotéticas y ajustes de fecha, monto o exclusión sin tocar los registros reales.
- **Multi‑moneda:** HNL, USD, EUR con tabla de tasas para el consolidado.
- **Integraciones:** webhook por entidad (CRM / n8n) que alimenta una bandeja de revisión antes de afectar el flujo.

Modelo de datos y reglas: [docs/DATABASE.md](docs/DATABASE.md). Reglas del proyecto: [AGENTS.md](AGENTS.md).

## Desarrollo local

```bash
cp .env.example .env        # completa secretos (openssl rand -base64 48)
docker compose up -d --build   # app en http://localhost:3020
npm install && npm run seed:demo   # datos de ejemplo (usa DATABASE_URL de .env)
```

Con recarga en caliente:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Inicia sesión con `ADMIN_EMAIL` / `ADMIN_PASSWORD` del `.env` (el admin se crea solo si no existe ningún usuario).

| Comando | Qué hace |
|---|---|
| `npm test` | Pruebas del motor de proyección (Vitest) |
| `npm run typecheck` / `npm run lint` | TypeScript y ESLint |
| `npm run seed:demo` | Datos demo: segunda entidad en USD, vencidos, abonos, recurrencias, transferencia y partidas hipotéticas. No borra nada y es idempotente. |
| `npm run db:migrate` | Aplica los SQL idempotentes (el contenedor ya lo hace al arrancar) |

## Arranque del contenedor

`docker-entrypoint.sh` corre en cada inicio:

1. `scripts/migrate.ts` aplica todos los `prisma/migrations/*.sql` (idempotentes, en transacción).
2. `prisma/bootstrap.ts` crea lo que falte: ajustes (HNL), **Entidad Base**, escenario What‑If y usuario ADMIN.
3. `next start`.

Nunca se usa `prisma db push`.

## Despliegue (servidor de la oficina)

Primera vez, en el servidor:

```bash
git clone git@github.com:<usuario>/<repo>.git /opt/cashflow-publimatec
cd /opt/cashflow-publimatec && cp .env.example .env   # completar con secretos de producción
```

Luego, cada despliegue desde tu computadora (con `SSH_HOST` y `REMOTE_DIR` configurados en `deploy.sh`):

```bash
git push origin master
./deploy.sh
```

El script valida que `master` local esté igual a GitHub, hace `pg_dump` (aborta si falla), `git pull --ff-only`,
`docker compose up -d --build` y verifica `/api/health`. Los respaldos quedan en `backups/` (se conservan 30).

Puertos: app `3020`, PostgreSQL `5440` (solo en `127.0.0.1`; usa un túnel SSH para conectarte desde fuera).
Con HTTPS delante (proxy inverso), pon `COOKIE_SECURE=true`.

## API (resumen)

Todas requieren sesión, salvo `/api/health`, `/api/auth/login` y el webhook.
Respuestas: montos en **centavos enteros**. Peticiones: montos como string decimal (`"1234.56"`). Fechas `YYYY-MM-DD`.
El contexto se pasa con `?ctx=all|<entityId>` y la simulación con `&whatIf=1`.

| Ruta | Uso |
|---|---|
| `GET /api/projection` | Proyección completa (KPIs, semanas, serie diaria, partidas) |
| `GET/POST /api/obligations`, `PATCH/DELETE /api/obligations/:id` | CxC / CxP |
| `POST /api/obligations/:id/payments` | Abono o liquidación (sin `amount` = total) |
| `GET/POST /api/recurrences`, `PATCH /api/recurrences/:id`, `POST .../materialize` | Recurrencias |
| `GET/POST /api/transfers`, `POST /api/transfers/:id` (`execute` / `cancel`) | Transferencias inter‑entidad |
| `PUT/DELETE /api/scenario/overrides` | Ajustes What‑If |
| `GET/POST /api/accounts`, `POST /api/accounts/:id/reconcile` | Cuentas y conciliación |
| `GET/POST /api/entities`, `PATCH /api/entities/:id`, `POST/DELETE .../webhook-token` | Entidades y webhook |
| `GET/POST /api/rates`, `GET/PATCH /api/settings`, `GET/POST/PATCH /api/users` | Configuración |
| `GET /api/staging`, `POST /api/staging/:id` (`approve` / `reject`) | Bandeja externa |
| `POST /api/webhooks/:token` | Entrada pública para CRM / n8n |

Ejemplo de webhook:

```bash
curl -X POST https://<host>/api/webhooks/<token> -H 'Content-Type: application/json' -d '{
  "type": "receivable", "description": "Factura 001-123", "amount": "15000.00",
  "dueDate": "2026-12-01", "counterparty": "Cliente S.A.",
  "externalId": "crm-991", "source": "crm-publimatec"
}'
```

`type` acepta `receivable` / `payable` (también `IN` / `OUT`). Si se repite `externalId` + `source`, no se duplica.

## Nota de seguridad

Next.js 14.2 está fuera de soporte y tiene avisos de seguridad que solo se corrigen en 15.5+. Aquí se usa el
último parche de la línea 14 (14.2.35), el optimizador de imágenes está desactivado y no se usan Server Actions
ni rewrites. Se recomienda migrar esta app y CRM Publimatec a Next 15.5 en conjunto.
