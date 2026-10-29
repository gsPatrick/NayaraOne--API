'use strict';

/**
 * M9-D681 — KPI ai.cost_by_agent (Custo de IA por agente), versão 1. Posição no mês de São Paulo da data-base: soma em reais das execuções CONCLUÍDAS por agente (a coluna de custo
 * só aceita BRL, então não há conversão de cotação), arredondada UMA vez, e o custo por execução = custo ÷ execuções (2 casas). O valor é o custo de todos os agentes; cada agente e cada
 * modelo têm a sua dimensão. Exemplo: NAY Comercial 640,00 em 8 execuções => 80,00 por execução. Entrada (rm_ai_cost do mês): { rows: [{ agent, costBrl, runs, runsWithoutCost,
 * byModel: { modelo: { cost_brl, runs } } }] }. Regra de qualidade: execução que chamou modelo e não gravou custo -> DEGRADED e sem valor.
 */
const money = require('./money');
const { degraded, incomplete, sumCounts } = require('./_legalCorKpi');
const { safe, total, distinct } = require('./_aiKpi');

const perRun = (cost, runs) => (money.cmp(runs, 0) > 0 ? money.money(money.div(cost, runs)) : null);

function modelsOf(rows) {
  const out = new Map();
  for (const row of rows) {
    for (const [model, v] of Object.entries(row.byModel || {})) {
      const prev = out.get(model) || { cost: '0', runs: '0' };
      out.set(model, { cost: money.toString(money.add(prev.cost, v.cost_brl ?? 0)), runs: money.count(money.add(prev.runs, v.runs ?? 0)) });
    }
  }
  return out;
}

function compute(input) {
  const rows = input.rows || [];
  if (rows.some((r) => r.runsWithoutCost === null || r.runsWithoutCost === undefined || !r.byModel)) return incomplete('AINDA_NAO_CALCULADO', {}); // campo novo do read model ainda nulo
  const without = sumCounts(rows.map((r) => r.runsWithoutCost));
  if (money.cmp(without, 0) > 0) return degraded('EXECUCAO_SEM_CUSTO', { runsWithoutCost: without });
  const cost = money.toString(total(rows, (r) => r.costBrl));
  const runs = sumCounts(rows.map((r) => r.runs));
  const dimensions = [];
  const byAgent = [];
  for (const agent of distinct(rows.map((r) => r.agent))) {
    const own = rows.filter((r) => r.agent === agent);
    const agentCost = money.toString(total(own, (r) => r.costBrl));
    const agentRuns = sumCounts(own.map((r) => r.runs));
    const each = perRun(agentCost, agentRuns);
    byAgent.push({ agent, cost: money.money(agentCost), runs: agentRuns, perRun: each });
    dimensions.push({ key: `agente:${safe(agent)}`, value: money.money(agentCost) }, { key: `agente:${safe(agent)}:execucoes_qtd`, value: agentRuns });
    if (each !== null) dimensions.push({ key: `agente:${safe(agent)}:custo_por_execucao_brl`, value: each });
  }
  const models = modelsOf(rows);
  const byModel = [];
  for (const model of distinct([...models.keys()])) {
    const m = models.get(model);
    byModel.push({ model, cost: money.money(m.cost), runs: m.runs });
    dimensions.push({ key: `modelo:${safe(model)}`, value: money.money(m.cost) }, { key: `modelo:${safe(model)}:execucoes_qtd`, value: m.runs });
  }
  return { value: money.money(cost), status: 'OK', details: { cost: money.money(cost), runs, perRun: perRun(cost, runs), byAgent, byModel }, dimensions };
}

const row = (agent, costBrl, runs, byModel, runsWithoutCost = 0) => ({ agent, costBrl, runs, runsWithoutCost, byModel });
const sm = (cost, runs) => ({ 'm-small': { cost_brl: cost, runs } });

const testCases = [
  { kind: 'empty', name: 'nenhuma execução no mês: custo zero, sem agente', input: { rows: [] }, expected: { value: '0.00', status: 'OK', details: { cost: '0.00', runs: '0', perRun: null, byAgent: [], byModel: [] }, dimensions: [] } },
  { kind: 'single', name: 'um agente, uma execução', input: { rows: [row('NAY_COMERCIAL', '12.50', 1, sm('12.500000', 1))] }, expected: { value: '12.50', status: 'OK', details: { cost: '12.50', runs: '1', perRun: '12.50', byAgent: [{ agent: 'NAY_COMERCIAL', cost: '12.50', runs: '1', perRun: '12.50' }], byModel: [{ model: 'm-small', cost: '12.50', runs: '1' }] }, dimensions: [{ key: 'agente:NAY_COMERCIAL', value: '12.50' }, { key: 'agente:NAY_COMERCIAL:execucoes_qtd', value: '1' }, { key: 'agente:NAY_COMERCIAL:custo_por_execucao_brl', value: '12.50' }, { key: 'modelo:m-small', value: '12.50' }, { key: 'modelo:m-small:execucoes_qtd', value: '1' }] } },
  {
    kind: 'typical', name: 'exemplo do livro: NAY Comercial 640,00 em 8 execuções => 80,00 por execução; outro agente em outro modelo',
    input: { rows: [row('NAY_COMERCIAL', '640.00', 8, sm('640.000000', 8)), row('NAY_FINANCEIRO', '15.50', 2, { 'm-large': { cost_brl: '15.500000', runs: 2 } })] }, expected: { value: '655.50', status: 'OK', details: { cost: '655.50', runs: '10', perRun: '65.55', byAgent: [{ agent: 'NAY_COMERCIAL', cost: '640.00', runs: '8', perRun: '80.00' }, { agent: 'NAY_FINANCEIRO', cost: '15.50', runs: '2', perRun: '7.75' }], byModel: [{ model: 'm-large', cost: '15.50', runs: '2' }, { model: 'm-small', cost: '640.00', runs: '8' }] }, dimensions: [{ key: 'agente:NAY_COMERCIAL', value: '640.00' }, { key: 'agente:NAY_COMERCIAL:execucoes_qtd', value: '8' }, { key: 'agente:NAY_COMERCIAL:custo_por_execucao_brl', value: '80.00' }, { key: 'agente:NAY_FINANCEIRO', value: '15.50' }, { key: 'agente:NAY_FINANCEIRO:execucoes_qtd', value: '2' }, { key: 'agente:NAY_FINANCEIRO:custo_por_execucao_brl', value: '7.75' }, { key: 'modelo:m-large', value: '15.50' }, { key: 'modelo:m-large:execucoes_qtd', value: '2' }, { key: 'modelo:m-small', value: '640.00' }, { key: 'modelo:m-small:execucoes_qtd', value: '8' }] },
  },
  {
    kind: 'period_edge', name: 'execução concluída sem custo gravado (chamou modelo): DEGRADED e sem valor, nenhum número enganoso',
    input: { rows: [row('NAY_COMERCIAL', '640.00', 8, sm('640.000000', 8), 1)] }, expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'EXECUCAO_SEM_CUSTO', runsWithoutCost: '1' }, dimensions: [] },
  },
  {
    kind: 'period_edge', name: 'read model ainda não recalculado (campos novos nulos): INCOMPLETE e sem valor, nunca zero',
    input: { rows: [{ agent: 'NAY_COMERCIAL', costBrl: '640.00', runs: 8, runsWithoutCost: null, byModel: null }] },
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'AINDA_NAO_CALCULADO' }, dimensions: [] },
  },
  {
    kind: 'rounding', name: 'custo por execução arredondado uma vez (meio para cima); modelo com ":" no código não quebra a chave',
    input: { rows: [row('NAY_COMERCIAL', '10.00', 3, { 'prov:m-1': { cost_brl: '6.666666', runs: 2 }, 'm-2': { cost_brl: '3.333334', runs: 1 } })] }, expected: { value: '10.00', status: 'OK', details: { cost: '10.00', runs: '3', perRun: '3.33', byAgent: [{ agent: 'NAY_COMERCIAL', cost: '10.00', runs: '3', perRun: '3.33' }], byModel: [{ model: 'm-2', cost: '3.33', runs: '1' }, { model: 'prov:m-1', cost: '6.67', runs: '2' }] }, dimensions: [{ key: 'agente:NAY_COMERCIAL', value: '10.00' }, { key: 'agente:NAY_COMERCIAL:execucoes_qtd', value: '3' }, { key: 'agente:NAY_COMERCIAL:custo_por_execucao_brl', value: '3.33' }, { key: 'modelo:m-2', value: '3.33' }, { key: 'modelo:m-2:execucoes_qtd', value: '1' }, { key: 'modelo:prov_m-1', value: '6.67' }, { key: 'modelo:prov_m-1:execucoes_qtd', value: '2' }] },
  },
];

module.exports = { id: 'ai.cost_by_agent', version: 1, compute, testCases };
