-- Las deudas requieren moneda y cuenta para que los reportes no mezclen
-- divisas ni atribuyan una deuda a una cuenta incorrecta.
BEGIN;

ALTER TABLE public.deudas
  ADD COLUMN IF NOT EXISTS moneda text;

DO $$
DECLARE
  cuenta_id_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO cuenta_id_type
  FROM pg_attribute AS a
  JOIN pg_class AS c ON c.oid = a.attrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'cuentas'
    AND a.attname = 'id'
    AND NOT a.attisdropped;

  IF cuenta_id_type IS NULL THEN
    RAISE EXCEPTION 'public.cuentas debe tener una columna id para relacionar las deudas';
  END IF;

  EXECUTE format(
    'ALTER TABLE public.deudas ADD COLUMN IF NOT EXISTS cuenta_id %s',
    cuenta_id_type
  );
END
$$;

ALTER TABLE public.deudas
  ALTER COLUMN moneda SET NOT NULL,
  ALTER COLUMN cuenta_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.deudas'::regclass
      AND conname = 'deudas_cuenta_id_fkey'
  ) THEN
    ALTER TABLE public.deudas
      ADD CONSTRAINT deudas_cuenta_id_fkey
      FOREIGN KEY (cuenta_id) REFERENCES public.cuentas(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

COMMIT;
