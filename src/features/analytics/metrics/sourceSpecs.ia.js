'use strict';

/**
 * M9-D681 / M9-D611 — origem dos números dos KPIs de IA: quais registros do módulo de IA reproduzem cada KPI. Custo: as execuções concluídas do mês (soma do custo gravado); qualidade:
 * as execuções da semana (a fundamentação sai do estado de cada uma; a nota da avaliação fica no read model, que soma os itens); orçamento: os orçamentos mensais ativos (o custo do
 * mês vem das execuções); chamadas bloqueadas: as chamadas de ferramenta em estado BLOCKED do mês, as mesmas que incrementam o contador nayaraone_api_ai_tool_calls_blocked_total quando o
 * pipeline da NAY as recusa (M9-D695). Nenhum prompt, resposta, argumento nem resultado nas colunas: só códigos, estados e valores.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const span = (f) => `de ${day(f.period && f.period.from)} até antes de ${day(f.period && f.period.to)}`;
const RUNS = { type: 'AI_RUNS', table: 'ai.ai_runs', columns: { period: 'started_at', status: 'status' } };

const SPECS = [
  { ...RUNS, metricCode: 'ai.cost_by_agent', valueColumn: 'cost_amount', describe: (f) => `Execuções concluídas da NAY ${span(f)} (soma do custo gravado em reais)` },
  { ...RUNS, metricCode: 'ai.quality_scores', describe: (f) => `Execuções da NAY ${span(f)} (a semana, de segunda a domingo), com a situação da fundamentação de cada uma` },
  { type: 'AI_BUDGETS', table: 'ai.budgets', columns: { period: 'period_start', status: 'status' }, metricCode: 'ai.budget', describe: (f) => `Orçamentos mensais ativos da NAY ${span(f)}; o custo do mês vem das execuções concluídas` },
  { type: 'AI_TOOL_CALLS', table: 'ai.tool_calls', columns: { period: 'started_at', status: 'status' }, metricCode: 'ai.tool_calls_blocked', describe: (f) => `Chamadas de ferramenta da NAY bloqueadas ${span(f)} (estado BLOCKED, com o motivo)` },
];

const DETAIL = {
  'ai.cost_by_agent': { columns: ['agent_name', 'model_code', 'status', 'cost_amount', 'started_at'], link: null },
  'ai.quality_scores': { columns: ['agent_name', 'grounding_status', 'status', 'started_at'], link: null },
  'ai.budget': { columns: ['agent_code', 'limit_amount', 'status', 'period_start'], link: null },
  'ai.tool_calls_blocked': { columns: ['tool_name', 'status', 'blocked_reason', 'started_at'], link: null },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAIL[spec.metricCode]);
}

module.exports = { IA_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
