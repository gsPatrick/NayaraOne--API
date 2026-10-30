'use strict';

/**
 * M9-D608 (reabertura L-2) — a tabela sombra do rebuild passa a ser por EMPRESA e modelo (`rm_<x>__rb<8 hex da empresa>`), para o lock do rebuild
 * também ser por empresa e modelo: o rebuild da empresa A não trava nem apaga a sombra da empresa B. As funções SECURITY DEFINER da migration 9701
 * (que recebiam só o modelo) são substituídas por versões que recebem também a empresa. O sufixo mantém o nome dentro de 63 bytes (modelo até 50).
 *
 * Idempotente. GRANT/EXECUTE ao nayara_runtime só se o role existir. Faixa de migrations do BI: 9701 a 9708 (+ 9709 desta correção).
 */
const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;

const guard = `
      IF p_model !~ '^rm_[a-z][a-z0-9_]*$' OR length(p_model) > 50 OR p_model IN ('rm_applied_events', 'rm_stale_aggregates') THEN
        RAISE EXCEPTION 'Read model inválido para reconstrução: %', p_model USING ERRCODE = 'ANA20';
      END IF;
      IF to_regclass(format('${SCHEMA}.%I', p_model)) IS NULL THEN
        RAISE EXCEPTION 'Read model inexistente no schema ${SCHEMA}: %', p_model USING ERRCODE = 'ANA21';
      END IF;
      IF p_company IS NULL THEN
        RAISE EXCEPTION 'Empresa obrigatória para a tabela sombra do rebuild' USING ERRCODE = 'ANA22';
      END IF;
      v_shadow := p_model || '__rb' || substr(replace(p_company::text, '-', ''), 1, 8);`;

const CREATE_FN = `
  CREATE OR REPLACE FUNCTION ${SCHEMA}.rebuild_shadow_create(p_model text, p_company uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  DECLARE v_shadow text;
  BEGIN${guard}
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
  CREATE OR REPLACE FUNCTION ${SCHEMA}.rebuild_shadow_drop(p_model text, p_company uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  DECLARE v_shadow text;
  BEGIN${guard}
    EXECUTE format('DROP TABLE IF EXISTS ${SCHEMA}.%I', v_shadow);
  END
  $fn$`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(CREATE_FN);
    await q(DROP_FN);
    await q(`REVOKE ALL ON FUNCTION ${SCHEMA}.rebuild_shadow_create(text, uuid), ${SCHEMA}.rebuild_shadow_drop(text, uuid) FROM PUBLIC`);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT EXECUTE ON FUNCTION ${SCHEMA}.rebuild_shadow_create(text, uuid), ${SCHEMA}.rebuild_shadow_drop(text, uuid) TO nayara_runtime;
        END IF;
      END $$;
    `);
    await q(`DROP FUNCTION IF EXISTS ${SCHEMA}.rebuild_shadow_create(text)`);
    await q(`DROP FUNCTION IF EXISTS ${SCHEMA}.rebuild_shadow_drop(text)`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP FUNCTION IF EXISTS ${SCHEMA}.rebuild_shadow_create(text, uuid)`);
    await q(`DROP FUNCTION IF EXISTS ${SCHEMA}.rebuild_shadow_drop(text, uuid)`);
    // as funções por modelo da migration 9701 voltam ao reexecutar o down dela; aqui só se retira a versão por empresa.
  },
};
