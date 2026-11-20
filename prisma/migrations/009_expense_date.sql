-- 009 — Fecha del gasto en las partidas de reembolso.
-- Idempotente y aditivo.
--   "Obligation"."expenseDate": fecha en que se hizo el gasto (compra) que se va a reembolsar.
--   La fecha esperada/vencimiento sigue siendo la del REEMBOLSO (cuando se mueve la caja).

ALTER TABLE "Obligation" ADD COLUMN IF NOT EXISTS "expenseDate" DATE;

-- Recupera la fecha de los reembolsos ligados a un consumo de tarjeta (la fecha de compra del consumo).
UPDATE "Obligation" o
   SET "expenseDate" = c."purchaseDate"
  FROM "CardCharge" c
 WHERE c."reimbursementTransferId" = o."transferId"
   AND o."expenseDate" IS NULL;

-- Recupera la fecha de los gastos pagados con tarjeta de una persona (quedó en las notas).
UPDATE "Obligation"
   SET "expenseDate" = substring("notes" from '^Gasto del (\d{4}-\d{2}-\d{2}) pagado')::date
 WHERE "expenseDate" IS NULL
   AND "notes" ~ '^Gasto del \d{4}-\d{2}-\d{2} pagado';
