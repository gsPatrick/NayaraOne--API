'use strict';

/**
 * Marco 9, M9-D206 — integration.provider_health: saúde, latência, quota e estado do circuit breaker por connection.
 *
 * Duas famílias de linha: a ATUAL (window_minutes = 0, uma por connection, guarda circuito e último health check)
 * e as janelas agregadas (5, 60 e 1440 minutos). Colunas além das do livro (justificativa em DI-D206-2):
 * `check_consecutive_failures` (health checks falhos seguidos, M9-D223) e `last_sample_at` (instante da última
 * chamada observada, base da regra UNKNOWN).
 *
 * O role de runtime NÃO recebe DELETE: o expurgo da retenção é feito por função SECURITY DEFINER que só enxerga a
 * empresa da sessão (DI-D206-4; M9-D244 chama esta função de integration.purge_expired()).
 */
const WINDOWS = [0, 5, 60, 1440];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`
      CREATE TABLE "integration"."provider_health" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        provider_code varchar(48) NOT NULL,
        window_start timestamptz NOT NULL,
        window_minutes integer NOT NULL CHECK (window_minutes IN (${WINDOWS.join(', ')})),
        calls_total integer NOT NULL DEFAULT 0 CHECK (calls_total >= 0),
        calls_success integer NOT NULL DEFAULT 0 CHECK (calls_success >= 0),
        calls_failed integer NOT NULL DEFAULT 0 CHECK (calls_failed >= 0),
        success_rate numeric(5,2) CHECK (success_rate IS NULL OR (success_rate >= 0 AND success_rate <= 100)),
        latency_p50_ms integer CHECK (latency_p50_ms IS NULL OR latency_p50_ms >= 0),
        latency_p95_ms integer CHECK (latency_p95_ms IS NULL OR latency_p95_ms >= 0),
        latency_p99_ms integer CHECK (latency_p99_ms IS NULL OR latency_p99_ms >= 0),
        rate_limit_count integer NOT NULL DEFAULT 0 CHECK (rate_limit_count >= 0),
        auth_failures integer NOT NULL DEFAULT 0 CHECK (auth_failures >= 0),
        retries_total integer NOT NULL DEFAULT 0 CHECK (retries_total >= 0),
        dlq_count integer NOT NULL DEFAULT 0 CHECK (dlq_count >= 0),
        backlog_count integer NOT NULL DEFAULT 0 CHECK (backlog_count >= 0),
        quota_limit integer CHECK (quota_limit IS NULL OR quota_limit >= 0),
        quota_remaining integer CHECK (quota_remaining IS NULL OR quota_remaining >= 0),
        quota_resets_at timestamptz,
        circuit_state varchar(10) NOT NULL DEFAULT 'CLOSED' CHECK (circuit_state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
        circuit_opened_at timestamptz,
        circuit_cooldown_s integer CHECK (circuit_cooldown_s IS NULL OR circuit_cooldown_s >= 0),
        consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
        half_open_successes integer NOT NULL DEFAULT 0 CHECK (half_open_successes >= 0),
        check_consecutive_failures integer NOT NULL DEFAULT 0 CHECK (check_consecutive_failures >= 0),
        health_status varchar(10) CHECK (health_status IS NULL OR health_status IN ('HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN')),
        last_sample_at timestamptz,
        last_check_at timestamptz,
        last_check_ok boolean,
        last_check_latency_ms integer CHECK (last_check_latency_ms IS NULL OR last_check_latency_ms >= 0),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT provider_health_calls_check CHECK (calls_success + calls_failed <= calls_total)
      );
    `);
    await q(`CREATE UNIQUE INDEX provider_health_window_unique ON "integration"."provider_health" (connection_id, window_minutes, window_start);`);
    await q(`CREATE UNIQUE INDEX provider_health_current_unique ON "integration"."provider_health" (connection_id) WHERE window_minutes = 0;`);
    await q(`CREATE INDEX provider_health_company_idx ON "integration"."provider_health" (company_id, window_minutes, window_start);`);

    await q(`ALTER TABLE "integration"."provider_health" ENABLE ROW LEVEL SECURITY;`);
    await q(`ALTER TABLE "integration"."provider_health" FORCE ROW LEVEL SECURITY;`);
    await q(`CREATE POLICY tenant_isolation ON "integration"."provider_health"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);

    // Expurgo da retenção das janelas (nunca a linha atual), só da empresa da sessão; prazo mínimo de 1 dia.
    await q(`
      CREATE FUNCTION "integration".purge_provider_health(p_days integer) RETURNS integer
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, "integration" AS $f$
      DECLARE
        v_company uuid := NULLIF(current_setting('app.company_id', true), '')::uuid;
        v_removed integer;
      BEGIN
        IF v_company IS NULL THEN
          RAISE EXCEPTION 'purge_provider_health exige a empresa da sessão (app.company_id)' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF p_days IS NULL OR p_days < 1 THEN
          RAISE EXCEPTION 'prazo de retenção inválido: %', p_days USING ERRCODE = 'invalid_parameter_value';
        END IF;
        DELETE FROM "integration"."provider_health"
         WHERE company_id = v_company AND window_minutes > 0
           AND window_start < now() - make_interval(days => p_days);
        GET DIAGNOSTICS v_removed = ROW_COUNT;
        RETURN v_removed;
      END $f$;
    `);
    await q(`REVOKE ALL ON FUNCTION "integration".purge_provider_health(integer) FROM PUBLIC;`);

    await q(`
      DO $g$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "integration" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE ON "integration"."provider_health" TO nayara_runtime;
          GRANT EXECUTE ON FUNCTION "integration".purge_provider_health(integer) TO nayara_runtime;
        END IF;
      END $g$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP FUNCTION IF EXISTS "integration".purge_provider_health(integer);');
    await q('DROP TABLE IF EXISTS "integration"."provider_health";');
  },
};
