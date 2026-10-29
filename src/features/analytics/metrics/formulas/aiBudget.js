'use strict';

/**
 * M9-D681 — KPI ai.budget (Budget de IA), versão 1. Posição no mês de São Paulo da data-base: consumo% = custo do mês ÷ orçamento mensal × 100 (2 casas, uma vez), por agente e no total,
 * e a projeção do mês = custo ÷ dia do mês × dias do mês (2 casas). Agente acima do limite do administrador (analytics.ia.alerta_budget_pct, padrão 80%) é sinalizado. Exemplo: 640,00
 * de 900,00 => 71,11%; no dia 20 de 30 a projeção é 960,00. Entrada (rm_ai_cost do mês): { rows: [{ agent, costBrl, budgetBrl }], dayOfMonth, daysInMonth }. Parâmetro: alertPct.
 * Regra de qualidade: agente sem orçamento definido, ou com orçamento zero -> INCOMPLETE e sem valor.
 */
const money = require('./money');
const { incomplete } = require('./_legalCorKpi');
const { safe, total, distinct } = require('./_aiKpi');

const DEFAULT_ALERT_PCT = 80;
const hasBudget = (r) => r.budgetBrl !== null && r.budgetBrl !== undefined;

function projection(cost, day, days) {
  const known = Number.isInteger(day) && day >= 1 && Number.isInteger(days) && days >= day;
  return known ? money.money(money.div(money.mul(cost, days), day)) : money.money(cost);
}

function compute(input, params = {}) {
  const rows = input.rows || [];
  const alertPct = params.alertPct ?? DEFAULT_ALERT_PCT;
  if (!rows.length) return incomplete('SEM_AGENTE_NO_MES', {});
  const without = distinct(rows.filter((r) => !hasBudget(r)).map((r) => r.agent));
  if (without.length) return incomplete('AGENTE_SEM_ORCAMENTO', { agents: without });
  const zero = distinct(rows.filter((r) => money.isZero(r.budgetBrl)).map((r) => r.agent));
  if (zero.length) return incomplete('ORCAMENTO_ZERO', { agents: zero });
  const cost = total(rows, (r) => r.costBrl);
  const limit = total(rows, (r) => r.budgetBrl);
  const dimensions = [];
  const byAgent = [];
  const alerts = [];
  for (const agent of distinct(rows.map((r) => r.agent))) {
    const own = rows.filter((r) => r.agent === agent);
    const agentCost = total(own, (r) => r.costBrl);
    const agentLimit = total(own, (r) => r.budgetBrl);
    const used = money.percent(agentCost, agentLimit).value;
    const over = money.cmp(money.mul(agentCost, 100), money.mul(alertPct, agentLimit)) > 0;
    if (over) alerts.push(agent);
    const projected = projection(agentCost, input.dayOfMonth, input.daysInMonth);
    byAgent.push({ agent, cost: money.money(agentCost), budget: money.money(agentLimit), usedPct: used, projection: projected, alert: over });
    dimensions.push(
      { key: `agente:${safe(agent)}`, value: used }, { key: `agente:${safe(agent)}:custo_brl`, value: money.money(agentCost) }, { key: `agente:${safe(agent)}:orcamento_brl`, value: money.money(agentLimit) },
      { key: `agente:${safe(agent)}:projecao_brl`, value: projected }, { key: `agente:${safe(agent)}:alerta_qtd`, value: over ? '1' : '0' }
    );
  }
  dimensions.unshift({ key: 'acima_do_alerta_qtd', value: String(alerts.length) });
  return { value: money.percent(cost, limit).value, status: 'OK', details: { cost: money.money(cost), budget: money.money(limit), alertPct: String(alertPct), alerts, byAgent }, dimensions };
}

const row = (agent, costBrl, budgetBrl) => ({ agent, costBrl, budgetBrl });

const testCases = [
  { kind: 'empty', name: 'nenhum agente no mês: INCOMPLETE e sem valor', input: { rows: [], dayOfMonth: 20, daysInMonth: 30 }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_AGENTE_NO_MES' }, dimensions: [] } },
  { kind: 'single', name: 'um agente sem gasto: 0,00% e projeção zero', input: { rows: [row('NAY_COMERCIAL', '0.00', '900.00')], dayOfMonth: 20, daysInMonth: 30 }, expected: { value: '0.00', status: 'OK', details: { cost: '0.00', budget: '900.00', alertPct: '80', alerts: [], byAgent: [{ agent: 'NAY_COMERCIAL', cost: '0.00', budget: '900.00', usedPct: '0.00', projection: '0.00', alert: false }] }, dimensions: [{ key: 'acima_do_alerta_qtd', value: '0' }, { key: 'agente:NAY_COMERCIAL', value: '0.00' }, { key: 'agente:NAY_COMERCIAL:custo_brl', value: '0.00' }, { key: 'agente:NAY_COMERCIAL:orcamento_brl', value: '900.00' }, { key: 'agente:NAY_COMERCIAL:projecao_brl', value: '0.00' }, { key: 'agente:NAY_COMERCIAL:alerta_qtd', value: '0' }] } },
  { kind: 'typical', name: 'exemplo do livro: 640,00 de 900,00 => 71,11%; dia 20 de 30 => projeção 960,00', input: { rows: [row('NAY_COMERCIAL', '640.00', '900.00')], dayOfMonth: 20, daysInMonth: 30 }, expected: { value: '71.11', status: 'OK', details: { cost: '640.00', budget: '900.00', alertPct: '80', alerts: [], byAgent: [{ agent: 'NAY_COMERCIAL', cost: '640.00', budget: '900.00', usedPct: '71.11', projection: '960.00', alert: false }] }, dimensions: [{ key: 'acima_do_alerta_qtd', value: '0' }, { key: 'agente:NAY_COMERCIAL', value: '71.11' }, { key: 'agente:NAY_COMERCIAL:custo_brl', value: '640.00' }, { key: 'agente:NAY_COMERCIAL:orcamento_brl', value: '900.00' }, { key: 'agente:NAY_COMERCIAL:projecao_brl', value: '960.00' }, { key: 'agente:NAY_COMERCIAL:alerta_qtd', value: '0' }] } },
  {
    kind: 'period_edge', name: 'agente sem orçamento definido: INCOMPLETE e sem valor',
    input: { rows: [row('NAY_COMERCIAL', '640.00', '900.00'), row('NAY_FINANCEIRO', '15.50', null)], dayOfMonth: 28, daysInMonth: 31 }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'AGENTE_SEM_ORCAMENTO', agents: ['NAY_FINANCEIRO'] }, dimensions: [] },
  },
  {
    kind: 'period_edge', name: 'orçamento zero: INCOMPLETE e sem valor (nunca divide por zero)', input: { rows: [row('NAY_COMERCIAL', '10.00', '0.00')], dayOfMonth: 28, daysInMonth: 31 }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'ORCAMENTO_ZERO', agents: ['NAY_COMERCIAL'] }, dimensions: [] },
  },
  {
    kind: 'rounding', name: 'consumo e projeção arredondados uma vez; acima do limite do administrador (75) só o financeiro (77,50%)',
    input: { rows: [row('NAY_COMERCIAL', '640.00', '900.00'), row('NAY_FINANCEIRO', '15.50', '20.00')], dayOfMonth: 28, daysInMonth: 31 }, params: { alertPct: 75 }, expected: { value: '71.25', status: 'OK', details: { cost: '655.50', budget: '920.00', alertPct: '75', alerts: ['NAY_FINANCEIRO'], byAgent: [{ agent: 'NAY_COMERCIAL', cost: '640.00', budget: '900.00', usedPct: '71.11', projection: '708.57', alert: false }, { agent: 'NAY_FINANCEIRO', cost: '15.50', budget: '20.00', usedPct: '77.50', projection: '17.16', alert: true }] }, dimensions: [{ key: 'acima_do_alerta_qtd', value: '1' }, { key: 'agente:NAY_COMERCIAL', value: '71.11' }, { key: 'agente:NAY_COMERCIAL:custo_brl', value: '640.00' }, { key: 'agente:NAY_COMERCIAL:orcamento_brl', value: '900.00' }, { key: 'agente:NAY_COMERCIAL:projecao_brl', value: '708.57' }, { key: 'agente:NAY_COMERCIAL:alerta_qtd', value: '0' }, { key: 'agente:NAY_FINANCEIRO', value: '77.50' }, { key: 'agente:NAY_FINANCEIRO:custo_brl', value: '15.50' }, { key: 'agente:NAY_FINANCEIRO:orcamento_brl', value: '20.00' }, { key: 'agente:NAY_FINANCEIRO:projecao_brl', value: '17.16' }, { key: 'agente:NAY_FINANCEIRO:alerta_qtd', value: '1' }] },
  },
];

module.exports = { id: 'ai.budget', version: 1, compute, testCases };
