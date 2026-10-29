'use strict';

/**
 * Marco 9, demanda M9-D608 (Caderno "Dashboards + BI + Centro de Comando", §14, Guia §4 e §21): suporte ao rebuild completo de read model.
 *
 *  - analytics.rm_applied_events.aggregate_key: chave do agregado (JSON das colunas de chave) que o evento atualizou. O rebuild usa
 *    para recalcular, depois da troca, os agregados tocados por eventos aplicados durante a reconstrução. Nulo nas linhas antigas.
 *  - analytics.read_model_refreshes.rebuild_reason e rebuild_diff: motivo (--motivo) e diferença entre a tabela atual e a sombra
 *    (linhas e hash antes e depois, linhas acrescentadas, removidas e alteradas) do refresh de gatilho REBUILD.
 *  - analytics.rebuild_shadow_create / rebuild_shadow_drop: criam e descartam a tabela sombra `rm_<x>__rebuild` de um read model
 *    (mesma estrutura, RLS ENABLE + FORCE, mesmas políticas de leitura por empresa e grupo e escrita só com app.analytics_writer = on).
 *    SECURITY DEFINER porque o role de runtime não tem CREATE no schema; só aceitam nome de read model que exista no schema analytics.
 *    A tabela sombra é transitória: nasce no início de uma reconstrução e é descartada ao fim (sucesso ou falha).
 *
 * Idempotente. GRANT/EXECUTE ao nayara_runtime só se o role existir. Faixa de migrations do BI: 9701 a 9708.
 */
const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;

const guard = (kind) => `
      IF p_model !~ '^rm_[a-z][a-z0-9_]*$' OR length(p_model) > 50 OR p_model IN ('rm_applied_events', 'rm_stale_aggregates') THEN
        RAISE EXCEPTION 'Read model inválido para reconstrução: %', p_model USING ERRCODE = 'ANA20';
      END IF;
      IF to_regclass(format('${SCHEMA}.%I', p_model)) IS NULL THEN
        RAISE EXCEPTION 'Read model inexistente no schema ${SCHEMA}: %', p_model USING ERRCODE = 'ANA21';
      END IF;
      v_shadow := p_model || '__rebuild'; -- ${kind}`;

const CREATE_FN = `
  CREATE OR REPLACE FUNCTION ${SCHEMA}.rebuild_shadow_create(p_model text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  DECLARE v_shadow text;
  BEGIN${guard('criar')}
    EXECUTE format('DROP TABLE IF EXISTS ${SCHEMA}.%I', v_shadow);
    EXECUTE format('CREATE TABLE ${SCHEMA}.%I (LIKE ${SCHEMA}.%I INCLUDING ALL)', v_shadow, p_model);
    EXECUTE format('ALTER TABLE ${SCHEMA}.%I ENABLE ROW LEVEL SECURITY', v_shadow);
    EXECUTE format('ALTER TABLE ${SCHEMA}.%I FORCE ROW LEVEL SECURITY', v_shadow);
    EXECUTE format($q$CREATE POLICY analytics_select ON ${SCHEMA}.%I FOR SELECT USING (${READ_TENANT})$q$, v_shadow);
    EXECUTE format($q$CREATE POLICY analytics_insert ON ${SCHEMA}.%I FOR INSERT WITH CHECK (${WRITER_ON} AND ${READ_TENANT})$q$, v_shadow);
    EXECUTE format($q$CREATE POLICY analytics_update ON ${SCHEMA}.%I FOR UPDATE USING (${WRITER_ON} AND ${READ_TENANT}) WITH CHECK (${WRITER_ON} AND ${READ_TENANT})$q$, v_shadow);
    EXECUTE format($q$CREATE POLICY analytics_delete ON ${SCHEMA}.%I FOR DELETE USING (${WRITER_ON} AND ${READ_TENANT})$q$, v_shadow);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ${SCHEMA}.%I TO nayara_runtime', v_shadow);
    END IF;
    RETURN v_shadow;
  END
  $fn$`;

const DROP_FN = `
  CREATE OR REPLACE FUNCTION ${SCHEMA}.rebuild_shadow_drop(p_model text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  DECLARE v_shadow text;
  BEGIN${guard('descartar')}
    EXECUTE format('DROP TABLE IF EXISTS ${SCHEMA}.%I', v_shadow);
  END
  $fn$`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE ${SCHEMA}.rm_applied_events ADD COLUMN IF NOT EXISTS aggregate_key text NULL`);
    await q(`ALTER TABLE ${SCHEMA}.read_model_refreshes ADD COLUMN IF NOT EXISTS rebuild_reason text NULL`);
    await q(`ALTER TABLE ${SCHEMA}.read_model_refreshes ADD COLUMN IF NOT EXISTS rebuild_diff jsonb NULL`);
    await q(CREATE_FN);
    await q(DROP_FN);
    await q(`REVOKE ALL ON FUNCTION ${SCHEMA}.rebuild_shadow_create(text), ${SCHEMA}.rebuild_shadow_drop(text) FROM PUBLIC`);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT EXECUTE ON FUNCTION ${SCHEMA}.rebuild_shadow_create(text), ${SCHEMA}.rebuild_shadow_drop(text) TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP FUNCTION IF EXISTS ${SCHEMA}.rebuild_shadow_create(text)`);
    await q(`DROP FUNCTION IF EXISTS ${SCHEMA}.rebuild_shadow_drop(text)`);
    await q(`ALTER TABLE ${SCHEMA}.read_model_refreshes DROP COLUMN IF EXISTS rebuild_diff`);
    await q(`ALTER TABLE ${SCHEMA}.read_model_refreshes DROP COLUMN IF EXISTS rebuild_reason`);
    await q(`ALTER TABLE ${SCHEMA}.rm_applied_events DROP COLUMN IF EXISTS aggregate_key`);
  },
};
