'use strict';

// Cálculo INDEPENDENTE dos KPIs de custo e avanço das obras (M9-D650): lê só as linhas das fontes (obras, etapas, orçamentos, lançamentos e contratos,
// por conexão de superusuário), sem read model, worker nem fórmula do catálogo. Fim do dia-base de São Paulo feito na mão (UTC-3 fixo). Decimal exato
// (money.js, só para os testes); a projeção usa a forma fechada da regra do livro, que não é a do SQL nem a do JavaScript do código.
const money = require('../../../src/features/analytics/metrics/formulas/money');

const REVENUE_STATUSES = ['SIGNED', 'ACTIVE', 'SUSPENDED', 'CLOSED'];

async function rowsOf(env, sql, replacements) {
  return (await env.admin.query(sql, { replacements }))[0];
}

/** Projeção do custo final pela regra do livro: custoAFazer × fator, sem arredondar no meio; nulo sem orçamento ou sem avanço. */
function forecastOf(budget, actual, percent) {
  if (budget === null || percent === null) return null;
  if (money.isZero(budget)) return null;
  if (money.cmp(percent, 0) <= 0) return money.money(money.add(actual, budget)); // realizado 0%: fator 1
  if (money.cmp(percent, 100) >= 0) return money.money(actual);
  const expected = money.div(money.mul(budget, percent), 100); // quanto já deveria ter custado
  if (money.cmp(actual, expected) >= 0) return money.money(money.div(money.mul(actual, 100), percent)); // fator de desvio >= 1: real + real × (100 − %) ÷ % = real × 100 ÷ %
  return money.money(money.add(actual, money.mul(budget, money.div(money.sub(100, percent), 100))));
}

async function projectFacts(env, t, project, asOf) {
  const stages = await rowsOf(env, 'SELECT planned_cost::text AS c, planned_pct::text AS p, measured_pct::text AS m FROM construction.project_stages WHERE company_id = :c AND project_id = :p AND deleted_at IS NULL', { c: t.companyId, p: project.id });
  const weight = (s) => (s.c !== null && money.cmp(s.c, 0) > 0 ? s.c : '1');
  const total = money.sum(stages.map(weight));
  const avg = (field) => (stages.length ? money.div(money.sum(stages.map((s) => money.mul(weight(s), s[field] === null ? 0 : s[field]))), total) : null);
  const [budget] = await rowsOf(env, 'SELECT baseline_amount::text AS v FROM construction.budgets WHERE company_id = :c AND project_id = :p AND deleted_at IS NULL AND approved_at IS NOT NULL AND baseline_amount IS NOT NULL ORDER BY approved_at DESC LIMIT 1', { c: t.companyId, p: project.id });
  const baseline = budget ? budget.v : project.budget_amount;
  const dayEnd = new Date(`${asOf}T00:00:00-03:00`).getTime() + 86400000;
  const [spent] = await rowsOf(env,
    `SELECT COALESCE(SUM(amount), 0)::text AS v FROM finance.financial_entries WHERE company_id = :c AND construction_project_id = :p AND nature = 'PAYABLE' AND status = 'SETTLED'
       AND reversal_of_entry_id IS NULL AND NOT is_third_party_funds AND settled_at < :end`, { c: t.companyId, p: project.id, end: new Date(dayEnd).toISOString() });
  const [revenue] = await rowsOf(env, 'SELECT COALESCE(SUM(total_value), 0)::text AS v FROM legal.contracts WHERE company_id = :c AND construction_project_id = :p AND deleted_at IS NULL AND status IN (:s)', { c: t.companyId, p: project.id, s: REVENUE_STATUSES });
  const planned = avg('p');
  const measured = avg('m');
  const forecast = forecastOf(baseline, spent.v, measured === null ? null : money.round(measured, 6));
  return { id: project.id, planned, measured, weight: baseline === null || money.cmp(baseline, 0) <= 0 ? '1' : baseline, baseline, actual: money.money(spent.v), forecast, revenue: revenue.v };
}

/** Os números da empresa recalculados do zero pelas linhas-fonte. */
async function companyFacts(env, t, asOf) {
  const projects = await rowsOf(env, 'SELECT id::text AS id, budget_amount::text AS budget_amount FROM construction.projects WHERE company_id = :c AND deleted_at IS NULL ORDER BY id', { c: t.companyId });
  const facts = [];
  for (const p of projects) facts.push(await projectFacts(env, t, p, asOf));
  const weight = money.sum(facts.map((f) => f.weight));
  const wavg = (field) => money.div(money.sum(facts.map((f) => money.mul(f.weight, f[field]))), weight);
  const planned = wavg('planned');
  const measured = wavg('measured');
  const revenue = money.sum(facts.map((f) => f.revenue));
  const forecast = money.sum(facts.map((f) => f.forecast));
  const margin = money.sub(revenue, forecast);
  return {
    projects: facts,
    progress: { planned: money.money(planned), actual: money.money(measured), deviation: money.money(money.sub(measured, planned)) },
    company: {
      baseline: money.money(money.sum(facts.map((f) => f.baseline))), actual: money.money(money.sum(facts.map((f) => f.actual))), forecast: money.money(forecast),
      revenue: money.money(revenue), margin: money.money(margin), marginPct: money.round(money.mul(money.div(margin, revenue), 100), 2),
    },
  };
}

module.exports = { companyFacts, projectFacts, forecastOf };
