'use strict';

/**
 * Marco 9, demanda M9-D698 (3.2): materialized view da série mensal do caixa e dos horizontes (últimos 24 meses, o último dia de cada mês
 * por empresa), a agregação pesada e histórica do painel Financeiro, refeita com REFRESH MATERIALIZED VIEW CONCURRENTLY (índice único em
 * (company_id, month): a leitura nunca é bloqueada).
 *
 * Materialized view NÃO tem RLS. Por isso:
 *  - o role de runtime não recebe nenhum acesso à view (REVOKE aqui, e os scripts de GRANT por schema reaplicam o REVOKE: ver
 *    scripts/lib/runtimeNoMatview.js); a leitura só passa por analytics.read_mv_finance_health_monthly(), SECURITY DEFINER, que devolve
 *    apenas as linhas da empresa e do grupo da sessão (app.company_id, app.group_id);
 *  - o refresh é a função analytics.mv_refresh(nome, statement_timeout_ms, lock_timeout_ms), SECURITY DEFINER, só para view analytics.mv_*
 *    COM índice único, com os limites do refresh do OLTP. O dono precisa ignorar RLS (superusuário ou BYPASSRLS), porque a view lê as
 *    tabelas de todas as empresas: sem isso a função recusa (ANA33) em vez de gerar uma view vazia ou incompleta.
 * Códigos: ANA30 nome inválido, ANA31 view inexistente, ANA32 sem índice único, ANA33 dono sem BYPASSRLS.
 * EXECUTE ao nayara_runtime só se o role existir. Idempotente. Faixa de migrations do BI: 9741 a 9748.
 */
const SCHEMA = 'analytics';
const VIEW = 'mv_finance_health_monthly';

const REFRESH_FN = `
  CREATE OR REPLACE FUNCTION ${SCHEMA}.mv_refresh(p_name text, p_statement_ms integer, p_lock_ms integer) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  DECLARE v_groups jsonb;
  BEGIN
    IF p_name !~ '^mv_[a-z][a-z0-9_]*$' OR length(p_name) > 50 THEN
      RAISE EXCEPTION 'Nome de materialized view inválido: %', p_name USING ERRCODE = 'ANA30';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_matviews WHERE schemaname = '${SCHEMA}' AND matviewname = p_name) THEN
      RAISE EXCEPTION 'Materialized view inexistente no schema ${SCHEMA}: %', p_name USING ERRCODE = 'ANA31';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = '${SCHEMA}' AND c.relname = p_name AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
    ) THEN
      RAISE EXCEPTION 'A materialized view % precisa de índice único para o refresh concorrente', p_name USING ERRCODE = 'ANA32';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
      RAISE EXCEPTION 'O dono da função precisa ignorar RLS para atualizar % de todas as empresas', p_name USING ERRCODE = 'ANA33';
    END IF;
    PERFORM set_config('statement_timeout', p_statement_ms::text, true);
    PERFORM set_config('lock_timeout', p_lock_ms::text, true);
    EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY ${SCHEMA}.%I', p_name);
    EXECUTE format('SELECT COALESCE(jsonb_object_agg(group_id::text, n), ''{}''::jsonb) FROM (SELECT group_id, count(*) AS n FROM ${SCHEMA}.%I GROUP BY group_id) g', p_name) INTO v_groups;
    RETURN v_groups;
  END
  $fn$`;

const READ_FN = `
  CREATE OR REPLACE FUNCTION ${SCHEMA}.read_${VIEW}() RETURNS TABLE (
    company_id uuid, group_id uuid, month text, last_as_of_date date, free_cash numeric, third_party_cash numeric,
    receivables_30d numeric, payables_30d numeric, overdue_amount numeric, source_snapshot_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
    SELECT m.company_id, m.group_id, m.month, m.last_as_of_date, m.free_cash, m.third_party_cash, m.receivables_30d, m.payables_30d, m.overdue_amount, m.source_snapshot_at
      FROM ${SCHEMA}.${VIEW} m
     WHERE m.company_id = NULLIF(current_setting('app.company_id', true), '')::uuid
       AND m.group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
     ORDER BY m.month
  $fn$`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ${SCHEMA}.${VIEW} AS
        SELECT DISTINCT ON (company_id, to_char(as_of_date, 'YYYY-MM'))
               company_id, group_id, to_char(as_of_date, 'YYYY-MM') AS month, as_of_date AS last_as_of_date,
               free_cash, third_party_cash, receivables_30d, payables_30d, overdue_amount, source_snapshot_at
          FROM ${SCHEMA}.rm_finance_health
         WHERE as_of_date >= (date_trunc('month', current_date) - interval '23 months')::date
         ORDER BY company_id, to_char(as_of_date, 'YYYY-MM'), as_of_date DESC
        WITH DATA
    `);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS ${VIEW}_company_month_uq ON ${SCHEMA}.${VIEW} (company_id, month)`);
    await q(`REVOKE ALL ON ${SCHEMA}.${VIEW} FROM PUBLIC`);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          EXECUTE 'REVOKE ALL ON ${SCHEMA}.${VIEW} FROM nayara_runtime';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_analytics_reader') THEN
          EXECUTE 'REVOKE ALL ON ${SCHEMA}.${VIEW} FROM nayara_analytics_reader';
        END IF;
      END $$;
    `);
    await q(REFRESH_FN);
    await q(READ_FN);
    await q(`REVOKE ALL ON FUNCTION ${SCHEMA}.mv_refresh(text, integer, integer), ${SCHEMA}.read_${VIEW}() FROM PUBLIC`);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT EXECUTE ON FUNCTION ${SCHEMA}.mv_refresh(text, integer, integer), ${SCHEMA}.read_${VIEW}() TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP FUNCTION IF EXISTS ${SCHEMA}.read_${VIEW}()`);
    await q(`DROP FUNCTION IF EXISTS ${SCHEMA}.mv_refresh(text, integer, integer)`);
    await q(`DROP MATERIALIZED VIEW IF EXISTS ${SCHEMA}.${VIEW}`);
  },
};
