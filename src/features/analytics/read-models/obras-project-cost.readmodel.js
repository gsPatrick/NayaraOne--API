'use strict';

/**
 * M9-D618 — read model rm_project_cost (schema analytics): uma linha por obra com o orçamento aprovado (baseline), o custo REAL, a projeção do
 * custo final (forecast, PROJECTED) e a receita contratada. Três séries que o KPI nunca soma (M9-D610).
 *  - budget_cost: baseline do orçamento aprovado mais recente (Budget.baseline_amount); sem orçamento aprovado, o orçamento da própria obra; senão nulo.
 *  - actual_cost: saídas LIQUIDADAS ligadas à obra (financial_entries.construction_project_id) até o fim do dia-base de SP, do ledger (nunca planilha
 *    paralela), sem estorno, sem cancelado e sem dinheiro de terceiros.
 *  - forecast_cost: método RITMO (D650) = real + max(0, baseline × (1 − realizado%)) × max(1, real ÷ (baseline × realizado%)); com realizado% = 0
 *    o fator é 1 (real + baseline, regra do livro); sem avanço medido (nulo) ou sem baseline é nulo (INCOMPLETE, nunca zero inventado).
 *    PLANEJADO = o baseline. Decimal exato no banco, arredondado uma vez, 2 casas.
 *  - projected_margin: receita contratada − forecast_cost (M9-D650); nulo quando o forecast é nulo. É a coluna que o detalhe da margem projetada soma.
 *  - contract_revenue: Σ valor dos contratos da obra nos status do parâmetro analytics.obra.receita_contrato_status.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { COST_EVENTS } = require('./obra.events');
const { projectAggregateKey, allProjectKeys, dayEndIso } = require('./obra.resolve');
const { readStageProgress, readProjectDates } = require('./obra.progress.query');
const { readForecastMethod, readContractStatuses } = require('./obra.settings');

async function readBudget(companyId, projectId, fallback, transaction) {
  const [rows] = await sequelize.query(
    `SELECT baseline_amount::text AS amount FROM construction.budgets
      WHERE company_id = :companyId AND project_id = :projectId AND deleted_at IS NULL AND approved_at IS NOT NULL AND baseline_amount IS NOT NULL
      ORDER BY approved_at DESC, id DESC LIMIT 1`,
    { replacements: { companyId, projectId }, transaction }
  );
  return rows.length ? rows[0].amount : fallback;
}

async function readLedgerAndRevenue(companyId, projectId, dayEnd, statuses, transaction) {
  const [[actual]] = await sequelize.query(
    `SELECT COALESCE(SUM(amount), 0)::text AS actual_cost FROM finance.financial_entries
      WHERE company_id = :companyId AND construction_project_id = :projectId AND nature = 'PAYABLE' AND status = 'SETTLED'
        AND reversal_of_entry_id IS NULL AND NOT is_third_party_funds AND settled_at < CAST(:dayEnd AS timestamptz)`,
    { replacements: { companyId, projectId, dayEnd }, transaction }
  );
  const [[revenue]] = await sequelize.query(
    `SELECT COALESCE(SUM(total_value), 0)::text AS contract_revenue FROM legal.contracts
      WHERE company_id = :companyId AND construction_project_id = :projectId AND deleted_at IS NULL AND status IN (:statuses)`,
    { replacements: { companyId, projectId, statuses }, transaction }
  );
  return { ...actual, ...revenue };
}

/** Projeção do custo final em decimal exato no banco. Devolve texto com 2 casas ou null (INCOMPLETE). */
async function forecastCost({ method, budget, actual, percent }, transaction) {
  if (budget === null || budget === undefined) return null;
  if (method === 'PLANEJADO') return Number(budget) >= 0 ? String(budget) : null;
  if (percent === null || percent === undefined) return null;
  if (Number(percent) <= 0) { // realizado 0%: o fator de desvio é 1 (livro, M9-D650), o custo a fazer é o orçamento inteiro
    const [[zero]] = await sequelize.query('SELECT ROUND(CAST(:actual AS numeric) + CAST(:budget AS numeric), 2)::text AS forecast', { replacements: { budget, actual }, transaction });
    return zero.forecast;
  }
  const [[row]] = await sequelize.query(
    `SELECT CASE WHEN CAST(:budget AS numeric) * CAST(:percent AS numeric) / 100 = 0 THEN NULL
       ELSE ROUND(CAST(:actual AS numeric)
         + GREATEST(0, CAST(:budget AS numeric) * (1 - CAST(:percent AS numeric) / 100))
           * GREATEST(1, CAST(:actual AS numeric) / (CAST(:budget AS numeric) * CAST(:percent AS numeric) / 100)), 2)::text END AS forecast`,
    { replacements: { budget, actual, percent }, transaction }
  );
  return row.forecast;
}

/** Margem projetada da obra (receita − forecast), 2 casas; nula sem forecast. */
async function projectedMargin(revenue, forecast, transaction) {
  if (forecast === null || forecast === undefined) return null;
  const [[row]] = await sequelize.query('SELECT ROUND(CAST(:revenue AS numeric) - CAST(:forecast AS numeric), 2)::text AS margin', { replacements: { revenue, forecast }, transaction });
  return row.margin;
}

async function recompute({ companyId, groupId, key, asOfDate, transaction }) {
  const projectId = key.project_id;
  const scope = { companyId, groupId };
  const project = await readProjectDates(companyId, projectId, transaction); // em sequência: uma transação só aceita uma consulta por vez
  const progress = await readStageProgress(companyId, projectId, transaction);
  const method = await readForecastMethod(scope, transaction);
  const statuses = await readContractStatuses(scope, transaction);
  const budget = await readBudget(companyId, projectId, project && project.budget_amount !== null ? project.budget_amount : null, transaction);
  const sums = await readLedgerAndRevenue(companyId, projectId, dayEndIso(asOfDate), statuses, transaction);
  const forecast = await forecastCost({ method, budget, actual: sums.actual_cost, percent: progress.actual_percent }, transaction);
  const margin = await projectedMargin(sums.contract_revenue, forecast, transaction);
  return { fields: { budget_cost: budget, actual_cost: sums.actual_cost, forecast_cost: forecast, contract_revenue: sums.contract_revenue, projected_margin: margin } };
}

const def = registerReadModel({
  name: 'rm_project_cost',
  version: 1,
  keyColumns: ['project_id'],
  eventTypes: [...COST_EVENTS],
  aggregateKey: projectAggregateKey,
  recompute,
  rebuild: { keys: allProjectKeys },
});

module.exports = { def, recompute, forecastCost };
