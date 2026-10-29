'use strict';

// M9-D035 — numbersPayload das tools de área da NAY Diretoria: quantidades, valores e percentuais saem do read model de cada área, sob o RLS da
// empresa, e o SERVIDOR escreve o valor na resposta ({{num:ref}}). Só agregados: nenhum item identifica cliente, contrato, caso ou obra.
const { registerNumberExtractor } = require('../../tools/numbers/extractors');

const cents = (n) => Number(n || 0).toFixed(2);
const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const item = (source, asOf) => (ref, label, value, unit) => ({ ref, label, value: unit === 'BRL' ? cents(value) : String(value), unit, source, asOf });

function pipelineItems(o) {
  const mk = item('crm.getPipelineSummary', o.generatedAt);
  return [
    mk('funil_abertas', 'Oportunidades em aberto', o.openCount, 'un'), mk('funil_valor', 'Valor esperado em aberto', o.openValue, 'BRL'),
    ...o.byStage.flatMap((e) => [mk(`funil_${slug(e.stage)}_qtd`, `Oportunidades na etapa ${e.stage}`, e.count, 'un'), mk(`funil_${slug(e.stage)}_valor`, `Valor esperado na etapa ${e.stage}`, e.value, 'BRL')]),
  ];
}

function portfolioItems(o) {
  const mk = item('construction.getPortfolioProgress', o.generatedAt);
  return [
    mk('obras_ativas', 'Obras em execução', o.activeCount, 'un'), mk('obras_atrasadas', 'Obras com prazo vencido', o.overdueCount, 'un'),
    mk('obras_abaixo_margem', 'Obras abaixo da margem mínima', o.belowMinMarginCount, 'un'), mk('obras_avanco_fisico', 'Avanço físico médio', o.avgPhysicalProgressPct, '%'),
    mk('obras_avanco_planejado', 'Avanço planejado médio', o.avgPlannedProgressPct, '%'),
  ];
}

function contractItems(o) {
  const mk = item('legal.getExpiringContracts', o.generatedAt);
  return o.bands.flatMap((b, i) => [
    mk(`contratos_f${i + 1}_qtd`, `Contratos a vencer até ${b.toDays} dias`, b.count, 'un'), mk(`contratos_f${i + 1}_valor`, `Valor dos contratos a vencer até ${b.toDays} dias`, b.total, 'BRL'),
    mk(`contratos_f${i + 1}_dias`, 'Limite da faixa de vencimento', b.toDays, 'dias'),
  ]);
}

function stalledItems(o) {
  const mk = item('correspondent.getStalledCases', o.asOf);
  return [
    mk('casos_parados_total', 'Casos de financiamento parados', o.total, 'un'), mk('casos_parados_limiar', 'Dias sem atividade para o caso ser considerado parado', o.thresholdDays, 'dias'),
    ...(o.byStage || []).map((e) => mk(`casos_parados_${slug(e.status)}`, `Casos parados na etapa ${e.status}`, e.count, 'un')),
    ...(o.items || []).map((c) => mk(`caso_${String(c.financingCaseId).replace(/-/g, '').slice(0, 8)}_parado_dias`, 'Dias sem atividade do caso', c.idleDays, 'dias')),
  ];
}

function stockItems(o) {
  const mk = item('inventory.getStockRisks', o.generatedAt);
  return [
    mk('estoque_em_risco', 'Itens de estoque em risco', o.atRiskCount, 'un'), mk('estoque_ruptura', 'Itens com risco de ruptura', o.stockoutCount, 'un'),
    mk('estoque_risco_alto', 'Itens em risco alto', o.byLevel.HIGH, 'un'), mk('estoque_risco_medio', 'Itens em risco médio', o.byLevel.MEDIUM, 'un'), mk('estoque_risco_baixo', 'Itens em risco baixo', o.byLevel.LOW, 'un'),
  ];
}

const EXTRACTORS = Object.freeze({
  'crm.getPipelineSummary': pipelineItems, 'construction.getPortfolioProgress': portfolioItems, 'legal.getExpiringContracts': contractItems,
  'correspondent.getStalledCases': stalledItems, 'inventory.getStockRisks': stockItems,
});

function registerDiretoriaNumbers() {
  for (const [tool, fn] of Object.entries(EXTRACTORS)) registerNumberExtractor(tool, fn);
}

module.exports = { registerDiretoriaNumbers, EXTRACTORS };
