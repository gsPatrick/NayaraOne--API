'use strict';

/**
 * M9-D618 (3.3) — leitura do avanço da obra a partir das etapas (ProjectStage), sob o RLS da empresa. Baseline = planejado informado em
 * cada etapa; actual = medido (atualizado quando a medição é aprovada). Médias PONDERADAS pelo custo planejado da etapa (peso 1 quando a
 * etapa não tem custo planejado, M9-D650): Σ peso × % ÷ Σ peso, em decimal exato no banco, 6 casas. Obra sem etapa devolve null
 * (sem cronograma baseline, o KPI fica INCOMPLETE).
 */
const { sequelize } = require('../../../models');
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

async function readStageProgress(companyId, projectId, transaction) {
  const [[row]] = await sequelize.query(
    `WITH s AS (
       SELECT CASE WHEN planned_cost > 0 THEN planned_cost ELSE 1 END AS w, COALESCE(planned_pct, 0) AS planned, COALESCE(measured_pct, 0) AS measured
         FROM construction.project_stages WHERE company_id = :companyId AND project_id = :projectId AND deleted_at IS NULL)
     SELECT count(*)::int AS stages,
            ROUND(SUM(w * planned) / NULLIF(SUM(w), 0), 6)::text AS baseline_percent,
            ROUND(SUM(w * measured) / NULLIF(SUM(w), 0), 6)::text AS actual_percent
       FROM s`,
    { replacements: { companyId, projectId }, transaction }
  );
  return row;
}

/** Datas da obra (calendário de São Paulo, 'AAAA-MM-DD' ou null) e orçamento informado na própria obra. */
async function readProjectDates(companyId, projectId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT to_char((starts_at AT TIME ZONE :tz)::date, 'YYYY-MM-DD') AS start_date,
            to_char((ends_at_planned AT TIME ZONE :tz)::date, 'YYYY-MM-DD') AS planned_end_date,
            to_char(actual_end_date, 'YYYY-MM-DD') AS actual_end_date, budget_amount::text AS budget_amount, status
       FROM construction.projects WHERE company_id = :companyId AND id = :projectId AND deleted_at IS NULL`,
    { replacements: { companyId, projectId, tz: BUSINESS_TIMEZONE }, transaction }
  );
  return rows[0] || null;
}

module.exports = { readStageProgress, readProjectDates };
