-- 006 — Orden visual de las entidades (menú de selección y Ajustes → Entidades).
-- Idempotente y aditivo: una columna con valor por defecto. No modifica datos existentes;
-- con todas en 0 el orden sigue siendo el de creación hasta que se reordenen.

ALTER TABLE "Entity" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;
