'use strict';

/**
 * M9-D028 — retenção do conteúdo da NAY. Resumos de entrada e saída passam a ter no máximo 2000 caracteres (nunca o prompt
 * ou o documento completo), as linhas ganham a marca content_purged_at e nasce a função ai.purge_ai_content, que expurga o
 * CONTEÚDO vencido (resumos, argumentos e resultado das ferramentas, trecho das fontes) e mantém os metadados, o custo e os
 * hashes. O prazo de cada run é o MENOR entre o da maior classificação das suas fontes (sem fontes: INTERNAL) e a retenção
 * contratada do provider (p_provider_caps). A exceção à imutabilidade do run final vive nos gatilhos
 * (migrations/_helpers/aiRunsFunctions.js) e só aceita APAGAR conteúdo com a marca de sessão ai.purge_mode ligada.
 */
const { criarFuncoesRuns } = require('./_helpers/aiRunsFunctions');

const CHAVES = "ARRAY['args','arguments','args_sanitized','argsSanitized','result','result_summary','resultSummary']";

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE ai.ai_runs NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.ai_runs DISABLE TRIGGER ai_runs_guard');
      await q('ALTER TABLE ai.ai_runs ADD COLUMN IF NOT EXISTS content_purged_at timestamptz NULL');
      await q('UPDATE ai.ai_runs SET input_summary = left(input_summary, 2000) WHERE char_length(input_summary) > 2000');
      await q('UPDATE ai.ai_runs SET output_summary = left(output_summary, 2000) WHERE char_length(output_summary) > 2000');
      await q('ALTER TABLE ai.ai_runs ENABLE TRIGGER ai_runs_guard');
      await q('ALTER TABLE ai.ai_runs DROP CONSTRAINT IF EXISTS ai_runs_input_summary_chk');
      await q('ALTER TABLE ai.ai_runs ADD CONSTRAINT ai_runs_input_summary_chk CHECK (input_summary IS NULL OR char_length(input_summary) <= 2000)');
      await q('ALTER TABLE ai.ai_runs DROP CONSTRAINT IF EXISTS ai_runs_output_summary_chk');
      await q('ALTER TABLE ai.ai_runs ADD CONSTRAINT ai_runs_output_summary_chk CHECK (output_summary IS NULL OR char_length(output_summary) <= 2000)');
      await q('CREATE INDEX IF NOT EXISTS ai_runs_retention_idx ON ai.ai_runs (company_id, created_at) WHERE content_purged_at IS NULL');
      await q('ALTER TABLE ai.ai_runs FORCE ROW LEVEL SECURITY');

      await q('ALTER TABLE ai.ai_sources NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.ai_sources ADD COLUMN IF NOT EXISTS content_purged_at timestamptz NULL');
      await q('ALTER TABLE ai.ai_sources FORCE ROW LEVEL SECURITY');

      await q(`CREATE OR REPLACE FUNCTION ai.strip_tool_content(p jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
        SELECT CASE jsonb_typeof(p)
          WHEN 'object' THEN p - ${CHAVES}
          WHEN 'array' THEN (SELECT COALESCE(jsonb_agg(CASE jsonb_typeof(e) WHEN 'object' THEN e - ${CHAVES} ELSE e END), '[]'::jsonb) FROM jsonb_array_elements(p) e)
          ELSE p END
      $f$`);
      await criarFuncoesRuns(q);

      await q(`CREATE OR REPLACE FUNCTION ai.purge_ai_content(p_public integer, p_internal integer, p_confidential integer, p_restricted integer,
          p_provider_caps jsonb DEFAULT '{}'::jsonb, p_now timestamptz DEFAULT now()) RETURNS jsonb
        LANGUAGE plpgsql SET search_path = pg_catalog, ai AS $f$
        DECLARE
          v_company uuid := NULLIF(current_setting('app.company_id', true), '')::uuid;
          v_runs integer; v_sources integer;
        BEGIN
          IF v_company IS NULL THEN
            RAISE EXCEPTION 'purge_ai_content exige a empresa da sessão (app.company_id)' USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF LEAST(p_public, p_internal, p_confidential, p_restricted) < 1 OR GREATEST(p_public, p_internal, p_confidential, p_restricted) > 3650 THEN
            RAISE EXCEPTION 'prazo de retenção inválido' USING ERRCODE = 'invalid_parameter_value';
          END IF;
          PERFORM set_config('ai.purge_mode', 'on', true);
          WITH venc AS (
            SELECT r.id FROM ai.ai_runs r
            LEFT JOIN LATERAL (
              SELECT max(CASE s.classification WHEN 'PUBLIC' THEN 1 WHEN 'INTERNAL' THEN 2 WHEN 'CONFIDENTIAL' THEN 3 ELSE 4 END) AS nivel
                FROM ai.ai_sources s WHERE s.ai_run_id = r.id) c ON true
            WHERE r.company_id = v_company AND r.content_purged_at IS NULL
              AND r.created_at < p_now - make_interval(days => LEAST(
                CASE COALESCE(c.nivel, 2) WHEN 1 THEN p_public WHEN 2 THEN p_internal WHEN 3 THEN p_confidential ELSE p_restricted END,
                COALESCE((p_provider_caps ->> r.provider_code)::integer, 2147483647)))
          ), fontes AS (
            UPDATE ai.ai_sources s SET excerpt = NULL, content_purged_at = p_now FROM venc
             WHERE s.ai_run_id = venc.id AND s.content_purged_at IS NULL RETURNING s.id
          ), execucoes AS (
            UPDATE ai.ai_runs r SET input_summary = NULL, output_summary = NULL, tool_calls_json = ai.strip_tool_content(r.tool_calls_json), content_purged_at = p_now
              FROM venc WHERE r.id = venc.id RETURNING r.id
          )
          SELECT (SELECT count(*) FROM execucoes), (SELECT count(*) FROM fontes) INTO v_runs, v_sources;
          PERFORM set_config('ai.purge_mode', 'off', true);
          RETURN jsonb_build_object('runs', v_runs, 'sources', v_sources);
        END $f$`);
      await q('REVOKE ALL ON FUNCTION ai.purge_ai_content(integer, integer, integer, integer, jsonb, timestamptz) FROM PUBLIC');
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT EXECUTE ON FUNCTION ai.purge_ai_content(integer, integer, integer, integer, jsonb, timestamptz) TO nayara_runtime;
            GRANT EXECUTE ON FUNCTION ai.strip_tool_content(jsonb) TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP FUNCTION IF EXISTS ai.purge_ai_content(integer, integer, integer, integer, jsonb, timestamptz)');
      await q('DROP INDEX IF EXISTS ai.ai_runs_retention_idx');
      await q('ALTER TABLE ai.ai_runs DROP CONSTRAINT IF EXISTS ai_runs_input_summary_chk');
      await q('ALTER TABLE ai.ai_runs DROP CONSTRAINT IF EXISTS ai_runs_output_summary_chk');
      await q('ALTER TABLE ai.ai_runs DROP COLUMN IF EXISTS content_purged_at');
      await q('ALTER TABLE ai.ai_sources DROP COLUMN IF EXISTS content_purged_at');
      await q('DROP FUNCTION IF EXISTS ai.strip_tool_content(jsonb)');
    });
  },
};
