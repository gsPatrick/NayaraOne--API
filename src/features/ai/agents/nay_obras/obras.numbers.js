'use strict';

// M9-D037 — numbersPayload das tools da NAY Obras: dias, percentuais e valores saem do serviço do Marco 6 já sob o RLS da empresa, e o
// SERVIDOR escreve o valor na resposta ({{num:ref}}). A referência leva o início do id da obra para duas obras no mesmo run não colidirem.
const { registerNumberExtractor } = require('../../tools/numbers/extractors');

const tag = (projectId) => String(projectId).replace(/-/g, '').slice(0, 8);
const item = (projectId, name, label, value, unit, source, asOf) => ({ ref: `obra_${tag(projectId)}_${name}`, label, value: String(value), unit, source, asOf });

function progressItems(out) {
  const asOf = out.updatedAt || undefined;
  const src = 'construction.getProjectProgress';
  const rows = [
    item(out.projectId, 'avanco_fisico', 'Avanço físico', out.physicalProgressPct, '%', src, asOf),
    item(out.projectId, 'avanco_planejado', 'Avanço planejado', out.plannedProgressPct, '%', src, asOf),
    item(out.projectId, 'atraso_dias', 'Atraso em relação ao prazo planejado', out.scheduleDelayDays, 'dias', src, asOf),
  ];
  return rows;
}

function budgetItems(out) {
  const src = 'construction.getBudgetVsActual';
  const rows = [
    item(out.projectId, 'orcado', 'Orçado', out.budgeted, 'BRL', src, out.asOf),
    item(out.projectId, 'realizado', 'Realizado', out.actual, 'BRL', src, out.asOf),
    item(out.projectId, 'desvio', 'Desvio de custo', out.deviation, 'BRL', src, out.asOf),
  ];
  if (out.deviationPct !== null && out.deviationPct !== undefined) rows.push(item(out.projectId, 'desvio_pct', 'Desvio de custo sobre o orçado', out.deviationPct, '%', src, out.asOf));
  return rows;
}

const countItems = (out, name, label, value, src) => item(out.projectId, name, label, value, 'un', src, out.asOf);

function registerObrasNumbers() {
  registerNumberExtractor('construction.getProjectProgress', progressItems);
  registerNumberExtractor('construction.getBudgetVsActual', budgetItems);
  registerNumberExtractor('construction.getDailyReports', (o) => [countItems(o, 'diarios_na_janela', 'Diários na janela', o.totalInWindow, 'construction.getDailyReports'), countItems(o, 'diarios_com_bloqueio', 'Diários com bloqueio', o.withBlockages, 'construction.getDailyReports')]);
  registerNumberExtractor('construction.getQualityNonConformities', (o) => [countItems(o, 'nc_abertas', 'Não conformidades abertas', o.open, 'construction.getQualityNonConformities'), countItems(o, 'nc_total', 'Não conformidades no total', o.total, 'construction.getQualityNonConformities')]);
  registerNumberExtractor('construction.getWarrantyCases', (o) => [countItems(o, 'garantias_abertas', 'Chamados de garantia abertos', o.open, 'construction.getWarrantyCases'), countItems(o, 'garantias_total', 'Chamados de garantia no total', o.total, 'construction.getWarrantyCases')]);
}

module.exports = { registerObrasNumbers, progressItems, budgetItems, tag };
