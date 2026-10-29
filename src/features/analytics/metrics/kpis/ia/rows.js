'use strict';

/**
 * M9-D681 — leitura dos read models de IA para o cálculo dos KPIs. Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o worker de read models gravou (M9-D607). Mês e
 * semana são os de São Paulo da data-base. As tabelas vêm das definições (a varredura de segurança M9-D700 só deixa citar o nome do read model na camada read-models e nas definições).
 */
const { sequelize } = require('../../../../../models');
const { DEFINITIONS } = require('./definitions');
const dates = require('../../period.dates');
const { latestSnapshotAt } = require('../legalCor/snapshotAt');

const T = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.metricCode, d.sourceReadModel])));
const select = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];
const text = (v) => (v === null || v === undefined ? null : String(v));
const monthStart = (day) => `${day.slice(0, 7)}-01`;

/** Segunda-feira (AAAA-MM-DD) da semana da data: o read model de qualidade agrupa a semana pela segunda. */
function weekStartOf(day) {
  const { y, m, d } = dates.parseDate(day);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
  return dates.addDays(day, -((weekday + 6) % 7));
}

const costRow = (r) => ({ agent: r.agent, costBrl: text(r.cost_brl), budgetBrl: text(r.budget_brl), runs: r.runs, runsWithoutCost: r.runs_without_cost, byModel: r.by_model });
const qualityRow = (r) => ({
  agent: r.agent, week: r.week, runs: r.runs, groundingRuns: r.grounding_runs, groundingScoreSum: text(r.grounding_score_sum), evalItems: r.eval_items, evalScoreSum: text(r.eval_score_sum),
});
const toolRow = (r) => ({ agent: r.agent, day: r.day, calls: r.calls, blocked: r.blocked, byTool: r.by_tool, byReason: r.by_reason });

async function loadIaRows(scope, asOfDate, settings, transaction) {
  const base = { companyId: scope.companyId, month: asOfDate.slice(0, 7), from: monthStart(asOfDate), asOf: asOfDate };
  const week = weekStartOf(asOfDate);
  const cost = (await select(
    `SELECT agent, cost_brl, budget_brl, runs, runs_without_cost, by_model FROM analytics.${T['ai.cost_by_agent']} WHERE company_id = :companyId AND month = :month ORDER BY agent`, base, transaction
  )).map(costRow);
  const quality = (await select(
    `SELECT agent, to_char(week, 'YYYY-MM-DD') AS week, runs, grounding_runs, grounding_score_sum, eval_items, eval_score_sum FROM analytics.${T['ai.quality_scores']}
      WHERE company_id = :companyId AND week <= CAST(:week AS date) AND week > CAST(:week AS date) - (7 * :weeks)::int ORDER BY week, agent`,
    { ...base, week, weeks: settings.qualityWeeks }, transaction
  )).map(qualityRow);
  const tools = (await select(
    `SELECT agent, to_char(day, 'YYYY-MM-DD') AS day, calls, blocked, by_tool, by_reason FROM analytics.${T['ai.tool_calls_blocked']}
      WHERE company_id = :companyId AND day >= CAST(:from AS date) AND day <= CAST(:asOf AS date) ORDER BY day, agent`, base, transaction
  )).map(toolRow);
  const at = (code) => latestSnapshotAt(scope.companyId, [T[code]], transaction);
  const { y, m } = dates.parseDate(asOfDate);
  return {
    cost, quality, tools, week, dayOfMonth: Number(asOfDate.slice(8, 10)), daysInMonth: dates.lastDayOfMonth(y, m),
    snapshotAt: Object.fromEntries(await Promise.all(Object.keys(T).map(async (code) => [code, await at(code)]))),
  };
}

module.exports = { loadIaRows, weekStartOf, IA_READ_MODELS: [...new Set(Object.values(T))] };
