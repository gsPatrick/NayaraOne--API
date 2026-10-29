'use strict';

/**
 * Marco 9, M9-D244 — integration.purge_expired(): a ÚNICA porta de expurgo e de redação por retenção das tabelas de
 * integração. O role de runtime (nayara_runtime) continua sem DELETE nelas e perde o EXECUTE das funções parciais que
 * as D203, D205 e D206 criaram: só chama purge_expired, que as chama por dentro (SECURITY DEFINER, dono = role de
 * migração, search_path fixo, só a empresa da sessão). Cada trecho roda se, e só se, o chamador mandou todos os prazos dele:
 *   health_days                                  -> purge_provider_health (janelas, nunca a linha atual)
 *   errors_days                                  -> apaga integration_errors com mais de N dias
 *   inbox_raw_days, inbox_days, inbox_dlq_raw_days -> purge_webhook_inbox
 *   dispatch_days, dispatch_payload_days         -> purge_dispatches
 * É a única função que liga `integration.purge_mode`, a exceção do gatilho de imutabilidade do payload_snapshot dos
 * envios (M9-D205 3.3): purge_dispatches deixa de ligá-la sozinha e recusa rodar sem ela. Devolve as contagens por tabela;
 * a auditoria da execução é gravada pelo serviço, na mesma transação.
 */
const PURGE_DISPATCHES_ANTIGA = `
  CREATE OR REPLACE FUNCTION "integration".purge_dispatches(p_days integer, p_payload_days integer) RETURNS jsonb
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
  END $f$;`;

const PURGE_DISPATCHES_NOVA = `
  CREATE OR REPLACE FUNCTION "integration".purge_dispatches(p_days integer, p_payload_days integer) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, "integration" AS $f$
  DECLARE
    v_company uuid := NULLIF(current_setting('app.company_id', true), '')::uuid;
    v_red integer; v_del integer;
  BEGIN
    IF v_company IS NULL THEN
      RAISE EXCEPTION 'purge_dispatches exige a empresa da sessão (app.company_id)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF current_setting('integration.purge_mode', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'purge_dispatches só roda de dentro de integration.purge_expired()' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_days IS NULL OR p_days < 1 OR p_payload_days IS NULL OR p_payload_days < 1 THEN
      RAISE EXCEPTION 'prazo de retenção inválido' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE "integration"."dispatches"
       SET payload_snapshot = jsonb_build_object('redacted', true, 'hash', payload_hash::text)
     WHERE company_id = v_company AND status IN ('CONFIRMED', 'CANCELLED')
       AND NOT (payload_snapshot ? 'redacted' AND payload_snapshot = jsonb_build_object('redacted', true, 'hash', payload_hash::text))
       AND COALESCE(confirmed_at, updated_at) < now() - make_interval(days => p_payload_days);
    GET DIAGNOSTICS v_red = ROW_COUNT;
    DELETE FROM "integration"."dispatches"
     WHERE company_id = v_company AND status IN ('CONFIRMED', 'CANCELLED')
       AND COALESCE(confirmed_at, updated_at) < now() - make_interval(days => p_days);
    GET DIAGNOSTICS v_del = ROW_COUNT;
    RETURN jsonb_build_object('redacted', v_red, 'deleted', v_del);
  END $f$;`;

const PURGE_EXPIRED = `
  CREATE FUNCTION "integration".purge_expired(p jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, "integration" AS $f$
  DECLARE
    v_company uuid := NULLIF(current_setting('app.company_id', true), '')::uuid;
    v_out jsonb := '{}'::jsonb;
    v_n integer;
    v_k text;
  BEGIN
    IF v_company IS NULL THEN
      RAISE EXCEPTION 'purge_expired exige a empresa da sessão (app.company_id)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
      RAISE EXCEPTION 'purge_expired exige um objeto com os prazos de retenção' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    FOR v_k IN SELECT jsonb_object_keys(p) LOOP
      IF v_k NOT IN ('health_days', 'errors_days', 'inbox_raw_days', 'inbox_days', 'inbox_dlq_raw_days', 'dispatch_days', 'dispatch_payload_days')
         OR jsonb_typeof(p -> v_k) <> 'number' OR (p ->> v_k) !~ '^[0-9]+$' OR (p ->> v_k)::numeric < 1 THEN
        RAISE EXCEPTION 'prazo de retenção inválido: %', v_k USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END LOOP;

    IF p ? 'dispatch_days' AND p ? 'dispatch_payload_days' THEN
      PERFORM set_config('integration.purge_mode', 'on', true);
      v_out := v_out || jsonb_build_object('dispatches', "integration".purge_dispatches((p ->> 'dispatch_days')::int, (p ->> 'dispatch_payload_days')::int));
      PERFORM set_config('integration.purge_mode', 'off', true);
    END IF;
    IF p ? 'inbox_raw_days' AND p ? 'inbox_days' AND p ? 'inbox_dlq_raw_days' THEN
      v_out := v_out || jsonb_build_object('webhook_inbox',
        "integration".purge_webhook_inbox((p ->> 'inbox_raw_days')::int, (p ->> 'inbox_days')::int, (p ->> 'inbox_dlq_raw_days')::int));
    END IF;
    IF p ? 'health_days' THEN
      v_out := v_out || jsonb_build_object('provider_health', "integration".purge_provider_health((p ->> 'health_days')::int));
    END IF;
    IF p ? 'errors_days' THEN
      DELETE FROM "integration"."integration_errors"
       WHERE company_id = v_company AND created_at < now() - make_interval(days => (p ->> 'errors_days')::int);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_out := v_out || jsonb_build_object('integration_errors', v_n);
    END IF;
    RETURN v_out;
  END $f$;`;

const guardado = (sql) => `DO $g$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN ${sql} END IF; END $g$;`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(PURGE_DISPATCHES_NOVA);
    await q(PURGE_EXPIRED);
    await q('REVOKE ALL ON FUNCTION "integration".purge_expired(jsonb) FROM PUBLIC;');
    await q(guardado(`
      GRANT USAGE ON SCHEMA "integration" TO nayara_runtime;
      GRANT EXECUTE ON FUNCTION "integration".purge_expired(jsonb) TO nayara_runtime;
      REVOKE EXECUTE ON FUNCTION "integration".purge_provider_health(integer) FROM nayara_runtime;
      REVOKE EXECUTE ON FUNCTION "integration".purge_webhook_inbox(integer, integer, integer) FROM nayara_runtime;
      REVOKE EXECUTE ON FUNCTION "integration".purge_dispatches(integer, integer) FROM nayara_runtime;`));
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(guardado(`
      GRANT EXECUTE ON FUNCTION "integration".purge_provider_health(integer) TO nayara_runtime;
      GRANT EXECUTE ON FUNCTION "integration".purge_webhook_inbox(integer, integer, integer) TO nayara_runtime;
      GRANT EXECUTE ON FUNCTION "integration".purge_dispatches(integer, integer) TO nayara_runtime;`));
    await q('DROP FUNCTION IF EXISTS "integration".purge_expired(jsonb);');
    await q(PURGE_DISPATCHES_ANTIGA);
  },
};
