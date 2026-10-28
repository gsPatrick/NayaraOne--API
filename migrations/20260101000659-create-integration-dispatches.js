'use strict';

/**
 * Marco 9, M9-D205 — integration.dispatches: toda chamada externa registrada como intent local ANTES de sair.
 * UNIQUE (connection_id, operation, idempotency_key). RLS ENABLE + FORCE. Gatilho de imutabilidade de
 * payload_snapshot, payload_hash, idempotency_key, operation e connection_id, com UMA exceção: a redação do snapshot
 * ({"redacted":true,"hash":...}) feita só dentro de integration.purge_dispatches (marca de sessão
 * integration.purge_mode='on'; M9-D244 a chama de integration.purge_expired()). O runtime não apaga linhas.
 */
const STATUSES = ['PENDING', 'SENDING', 'SUBMITTED', 'CONFIRMED', 'RETRY_WAIT', 'UNKNOWN', 'FAILED', 'DEAD_LETTER', 'CANCELLED'];
const CLASSES = ['TRANSIENT', 'RATE_LIMIT', 'AUTH', 'VALIDATION', 'UNKNOWN'];
const lista = (xs) => xs.map((x) => `'${x}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);

    await q(`
      CREATE TABLE "integration"."dispatches" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        provider_code varchar(48) NOT NULL,
        operation varchar(64) NOT NULL CHECK (length(operation) > 0),
        outbox_event_id uuid REFERENCES "integration"."outbox_events"(id) ON DELETE SET NULL ON UPDATE CASCADE,
        aggregate_type varchar(128),
        aggregate_id uuid,
        status varchar(14) NOT NULL DEFAULT 'PENDING' CHECK (status IN (${lista(STATUSES)})),
        criticality_op varchar(10) NOT NULL DEFAULT 'DANGEROUS' CHECK (criticality_op IN ('DANGEROUS', 'SAFE')),
        payload_snapshot jsonb NOT NULL,
        payload_hash char(64) NOT NULL,
        idempotency_key varchar(120) NOT NULL CHECK (length(idempotency_key) > 0),
        external_request_id varchar(160),
        external_resource_id varchar(160),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts integer NOT NULL CHECK (max_attempts >= 1),
        next_attempt_at timestamptz,
        last_error_class varchar(12) CHECK (last_error_class IS NULL OR last_error_class IN (${lista(CLASSES)})),
        last_error_code varchar(64),
        last_http_status integer,
        confirmed_at timestamptz,
        unknown_since timestamptz,
        reconcile_attempts integer NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
        correlation_id uuid,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT dispatches_idempotency_unique UNIQUE (connection_id, operation, idempotency_key)
      );
    `);
    await q('CREATE INDEX dispatches_worker_idx ON "integration"."dispatches" (status, next_attempt_at);');
    await q('CREATE INDEX dispatches_aggregate_idx ON "integration"."dispatches" (company_id, aggregate_type, aggregate_id);');

    await q('ALTER TABLE "integration"."dispatches" ENABLE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY tenant_isolation ON "integration"."dispatches"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
    await q('ALTER TABLE "integration"."dispatches" FORCE ROW LEVEL SECURITY;');

    await q(`
      CREATE FUNCTION "integration".dispatches_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR NEW.operation IS DISTINCT FROM OLD.operation
           OR NEW.connection_id IS DISTINCT FROM OLD.connection_id THEN
          RAISE EXCEPTION 'INTEGRATION_DISPATCH_IMMUTABLE: o conteúdo aprovado de um envio não pode ser alterado' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.payload_snapshot IS DISTINCT FROM OLD.payload_snapshot THEN
          -- Única exceção: a redação de retenção, feita só dentro de integration.purge_dispatches.
          IF current_setting('integration.purge_mode', true) = 'on'
             AND NEW.payload_snapshot = jsonb_build_object('redacted', true, 'hash', OLD.payload_hash::text) THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'INTEGRATION_DISPATCH_IMMUTABLE: o conteúdo aprovado de um envio não pode ser alterado' USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $f$;
    `);
    await q(`CREATE TRIGGER dispatches_immutable BEFORE UPDATE ON "integration"."dispatches"
      FOR EACH ROW EXECUTE FUNCTION "integration".dispatches_immutable();`);

    // Retenção da empresa da sessão: redige o snapshot (CONFIRMED/CANCELLED) e apaga a linha vencida.
    await q(`
      CREATE FUNCTION "integration".purge_dispatches(p_days integer, p_payload_days integer) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, "integration" AS $f$
      DECLARE
        v_company uuid := NULLIF(current_setting('app.company_id', true), '')::uuid;
        v_red integer; v_del integer;
      BEGIN
        IF v_company IS NULL THEN
          RAISE EXCEPTION 'purge_dispatches exige a empresa da sessão (app.company_id)' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF p_days IS NULL OR p_days < 1 OR p_payload_days IS NULL OR p_payload_days < 1 THEN
          RAISE EXCEPTION 'prazo de retenção inválido' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        PERFORM set_config('integration.purge_mode', 'on', true);
        UPDATE "integration"."dispatches"
           SET payload_snapshot = jsonb_build_object('redacted', true, 'hash', payload_hash::text)
         WHERE company_id = v_company AND status IN ('CONFIRMED', 'CANCELLED')
           AND NOT (payload_snapshot ? 'redacted' AND payload_snapshot = jsonb_build_object('redacted', true, 'hash', payload_hash::text))
           AND COALESCE(confirmed_at, updated_at) < now() - make_interval(days => p_payload_days);
        GET DIAGNOSTICS v_red = ROW_COUNT;
        PERFORM set_config('integration.purge_mode', 'off', true);
        DELETE FROM "integration"."dispatches"
         WHERE company_id = v_company AND status IN ('CONFIRMED', 'CANCELLED')
           AND COALESCE(confirmed_at, updated_at) < now() - make_interval(days => p_days);
        GET DIAGNOSTICS v_del = ROW_COUNT;
        RETURN jsonb_build_object('redacted', v_red, 'deleted', v_del);
      END $f$;
    `);
    await q('REVOKE ALL ON FUNCTION "integration".purge_dispatches(integer, integer) FROM PUBLIC;');

    await q(`
      DO $g$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "integration" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE ON "integration"."dispatches" TO nayara_runtime;
          GRANT EXECUTE ON FUNCTION "integration".purge_dispatches(integer, integer) TO nayara_runtime;
        END IF;
      END $g$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP FUNCTION IF EXISTS "integration".purge_dispatches(integer, integer);');
    await q('DROP TABLE IF EXISTS "integration"."dispatches";');
    await q('DROP FUNCTION IF EXISTS "integration".dispatches_immutable();');
  },
};
