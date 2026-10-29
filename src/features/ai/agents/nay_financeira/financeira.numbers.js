'use strict';

// M9-D036 — numbersPayload das tools novas da NAY Financeira: os valores saem do Financeiro (relatório semanal, projeção e anomalias), sob o
// RLS da empresa, e o SERVIDOR escreve o valor na resposta ({{num:ref}}). Os números de texto livre do motivo de uma anomalia viram itens
// com a origem no próprio caso. Nada é calculado pelo modelo.
const { registerNumberExtractor } = require('../../tools/numbers/extractors');
const { extractEntities } = require('../../orchestrator/numbers/textEntities');

const cents = (n) => Number(n || 0).toFixed(2);
const tag = (id) => String(id).replace(/-/g, '').slice(0, 8);

function cashflowItems(o) {
  return o.items.map((i) => ({ ref: `fluxo_${i.indicator}`, label: i.label, value: cents(i.value), unit: 'BRL', source: o.source, asOf: o.generatedAt }));
}

/** Números do texto livre do motivo (ex.: "3 vezes a média") com origem no caso que os cita. */
function reasonNumbers(c, asOf) {
  return extractEntities(c.reason).filter((e) => e.kind === 'n').map((e, i) => ({
    ref: `anomalia_${tag(c.caseId)}_motivo${i}`, label: 'Número citado no motivo do caso', value: String(e.key), unit: ['BRL', '%'].includes(e.unit) ? e.unit : 'un', source: 'finance.anomaly_cases', asOf,
  }));
}

function anomalyItems(o) {
  const mk = (ref, label, value, unit) => ({ ref, label, value: unit === 'BRL' ? cents(value) : String(value), unit, source: o.source, asOf: o.generatedAt });
  return [
    mk('anomalias_abertas', 'Anomalias abertas', o.openCount, 'un'),
    ...Object.entries(o.byRisk || {}).map(([level, n]) => mk(`anomalias_${level.toLowerCase()}`, `Anomalias abertas de risco ${level}`, n, 'un')),
    mk('fin005_multiplicador', 'Multiplicador sobre o histórico (FIN-005)', o.rule.historyMultiplier, 'un'),
    mk('fin005_conta_nova', 'Valor acima do qual pagamento a conta nova é anomalia (FIN-005)', o.rule.newAccountThreshold, 'BRL'),
    mk('fin005_resfriamento', 'Horas de resfriamento de conta nova (FIN-005)', o.rule.cooldownHours, 'un'),
    ...o.items.flatMap((c) => reasonNumbers(c, o.generatedAt)),
  ];
}

function registerFinanceiraNumbers() {
  registerNumberExtractor('finance.getCashflowProjection', cashflowItems);
  registerNumberExtractor('finance.getAnomalies', anomalyItems);
}

module.exports = { registerFinanceiraNumbers, cashflowItems, anomalyItems, tag };
