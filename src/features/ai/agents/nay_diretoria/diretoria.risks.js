'use strict';

// M9-D035 — riscos priorizados da Diretoria: REGRA de código sobre as saídas dos read models (o modelo não pontua nada). Cada risco leva a
// severidade (limites em parâmetro da empresa), a quantidade e a fonte do read model de onde veio.
const { fractionToPercent } = require('../../orchestrator/numbers/decimalText');
const { DIRETORIA_KEYS: K } = require('./diretoria.settings');

const RANK = Object.freeze({ ALTA: 3, MEDIA: 2, BAIXA: 1 });
const LABEL = Object.freeze({ ALTA: 'Alta', MEDIA: 'Média', BAIXA: 'Baixa' });
const FINANCE_SOURCE = 'finance.getWeeklyHealthReport';

const bySize = (count, p) => (count >= p.riskHighMinItems ? 'ALTA' : count >= p.riskMediumMinItems ? 'MEDIA' : 'BAIXA');

function byRatio(pct, p) {
  const v = Number(pct);
  return v >= p.delinquencyHighPct ? 'ALTA' : v >= p.delinquencyMediumPct ? 'MEDIA' : 'BAIXA';
}

const risk = (id, theme, severity, count, source, asOf, extra = {}) => ({ id, theme, severity, count, source, asOf, ...extra });

/** Um risco por tema com ocorrência; área sem leitura (sem acesso) não gera risco. `areas` vem de readAreas. */
function buildRisks(areas, p) {
  const out = (topic) => (areas.find((a) => a.topic === topic) || {}).output || null;
  const risks = [];
  const fin = out('finance');
  if (fin && fin.overdue.receivable.count > 0) {
    const pct = fractionToPercent(fin.delinquencyRatio || 0);
    risks.push(risk('inadimplencia', 'Inadimplência', byRatio(pct, p), fin.overdue.receivable.count, FINANCE_SOURCE, fin.generatedAt, { value: fin.overdue.receivable.total, pct }));
  }
  const leg = out('legal');
  if (leg && leg.bands.length && leg.bands[0].count > 0) {
    risks.push(risk('contratos', 'Contratos a vencer', bySize(leg.bands[0].count, p), leg.bands[0].count, leg.source, leg.generatedAt, { value: leg.bands[0].total, days: leg.bands[0].toDays }));
  }
  const obr = out('construction');
  if (obr && obr.overdueCount > 0) risks.push(risk('obras', 'Obras atrasadas', bySize(obr.overdueCount, p), obr.overdueCount, obr.source, obr.generatedAt, { active: obr.activeCount }));
  const cor = out('correspondent');
  if (cor && cor.total > 0) risks.push(risk('casos', 'Casos de financiamento parados', bySize(cor.total, p), cor.total, cor.source, cor.asOf, { days: cor.thresholdDays }));
  const est = out('inventory');
  if (est && est.byLevel.HIGH > 0) risks.push(risk('estoque', 'Estoque em risco alto', bySize(est.byLevel.HIGH, p), est.byLevel.HIGH, est.source, est.generatedAt, { stockout: est.stockoutCount }));
  return risks.sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.count - a.count).slice(0, p.maxRisks);
}

/** Parâmetros efetivos (limites de severidade e tamanho da lista): chaves em diretoria.settings.js, lidos pelo chamador. */
const PARAM_FIELDS = Object.freeze({
  riskMediumMinItems: K.riskMediumMinItems, riskHighMinItems: K.riskHighMinItems, delinquencyMediumPct: K.delinquencyMediumPct,
  delinquencyHighPct: K.delinquencyHighPct, maxRisks: K.maxRisks,
});

module.exports = { buildRisks, PARAM_FIELDS, RANK, LABEL, FINANCE_SOURCE };
