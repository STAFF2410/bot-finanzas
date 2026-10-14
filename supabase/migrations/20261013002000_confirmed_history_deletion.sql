BEGIN;

ALTER TABLE public.deudas
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.tareas_pendientes
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.acciones_pendientes (
  id uuid PRIMARY KEY,
  chat_id bigint NOT NULL,
  requester_user_id bigint NOT NULL,
  tipo text NOT NULL CHECK (tipo = 'eliminar_historial_hoy'),
  fecha_desde timestamptz NOT NULL,
  fecha_hasta timestamptz NOT NULL,
  conteos jsonb NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'cancelada', 'completada', 'expirada')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  confirmed_at timestamptz,
  resultado jsonb,
  CONSTRAINT acciones_pendientes_fecha_check CHECK (fecha_desde < fecha_hasta)
);

ALTER TABLE public.acciones_pendientes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.acciones_pendientes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.acciones_pendientes TO service_role;

CREATE OR REPLACE FUNCTION public.confirmar_eliminacion_historial_hoy(
  p_action_id uuid,
  p_chat_id bigint,
  p_requester_user_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  accion public.acciones_pendientes%ROWTYPE;
  eliminados_memoria bigint;
  eliminadas_transacciones bigint;
  eliminadas_deudas bigint;
  eliminadas_tareas bigint;
  resumen jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Esta accion solo puede ejecutarse desde el servidor autorizado';
  END IF;

  SELECT *
    INTO accion
  FROM public.acciones_pendientes
  WHERE id = p_action_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe la solicitud de eliminacion';
  END IF;
  IF accion.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'La solicitud ya fue procesada';
  END IF;
  IF accion.expires_at <= now() THEN
    RAISE EXCEPTION 'La solicitud de confirmacion ha expirado';
  END IF;
  IF accion.chat_id <> p_chat_id
      OR accion.requester_user_id <> p_requester_user_id THEN
    RAISE EXCEPTION 'La solicitud no pertenece a este usuario autorizado';
  END IF;
  IF accion.tipo <> 'eliminar_historial_hoy'
      OR accion.conteos IS NULL
      OR jsonb_object_length(accion.conteos) <> 4
      OR NOT accion.conteos ?& ARRAY[
        'memoria_chat',
        'transacciones',
        'deudas',
        'tareas_pendientes'
      ]
      OR accion.fecha_hasta - accion.fecha_desde < interval '23 hours'
      OR accion.fecha_hasta - accion.fecha_desde > interval '25 hours' THEN
    RAISE EXCEPTION 'El alcance de la solicitud no es valido';
  END IF;

  DELETE FROM public.memoria_chat
    WHERE fecha_creacion >= accion.fecha_desde
      AND fecha_creacion < accion.fecha_hasta;
  GET DIAGNOSTICS eliminados_memoria = ROW_COUNT;

  DELETE FROM public.transacciones
    WHERE fecha >= accion.fecha_desde
      AND fecha < accion.fecha_hasta;
  GET DIAGNOSTICS eliminadas_transacciones = ROW_COUNT;

  DELETE FROM public.deudas
    WHERE created_at >= accion.fecha_desde
      AND created_at < accion.fecha_hasta;
  GET DIAGNOSTICS eliminadas_deudas = ROW_COUNT;

  DELETE FROM public.tareas_pendientes
    WHERE created_at >= accion.fecha_desde
      AND created_at < accion.fecha_hasta;
  GET DIAGNOSTICS eliminadas_tareas = ROW_COUNT;

  resumen := jsonb_build_object(
    'memoria_chat', eliminados_memoria,
    'transacciones', eliminadas_transacciones,
    'deudas', eliminadas_deudas,
    'tareas_pendientes', eliminadas_tareas
  );

  UPDATE public.acciones_pendientes
    SET estado = 'completada',
        confirmed_at = now(),
        resultado = resumen
    WHERE id = accion.id;

  RETURN resumen;
END;
$$;

REVOKE ALL ON FUNCTION public.confirmar_eliminacion_historial_hoy(uuid, bigint, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_eliminacion_historial_hoy(uuid, bigint, bigint)
  TO service_role;

COMMIT;
