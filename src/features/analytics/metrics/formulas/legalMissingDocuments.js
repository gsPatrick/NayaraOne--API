'use strict';

/**
 * M9-D660 — KPI legal.missing_documents (Documentos faltantes), versão 1. Posição no fim do dia-base: exigências documentais de contratos ainda
 * pendentes (nem atendidas nem dispensadas), por tipo, e em quantos contratos; o valor é o total de exigências pendentes da empresa e a dimensão
 * contratos_qtd traz os contratos distintos (exemplo: 31 exigências em 12 contratos). Entrada (rm_legal_missing_docs, a linha TODOS é a empresa):
 * { rows: [{ type, contracts, requirements, withoutDeadline }] }. Parâmetro: maxNoDeadlinePct (analytics.qualidade.max_exigencia_sem_prazo_pct, padrão
 * 0). Regra de qualidade: exigência pendente sem prazo (contrato sem início de vigência) acima do limite -> DEGRADED, valor nulo; campo ainda não
 * recalculado pelo read model (nulo) também deixa DEGRADED.
 */
const money = require('./money');
const { degraded, exceedsPct, byText, ALL_TYPES } = require('./_legalCorKpi');

function compute(input, params = {}) {
  const maxNoDeadlinePct = Number.isInteger(params.maxNoDeadlinePct) ? params.maxNoDeadlinePct : 0;
  const rows = input.rows || [];
  const all = rows.find((r) => r.type === ALL_TYPES);
  const requirements = money.count(all ? all.requirements : 0);
  const contracts = money.count(all ? all.contracts : 0);
  if (all && (all.withoutDeadline === null || all.withoutDeadline === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', { requirements, contracts });
  const withoutDeadline = money.count(all ? all.withoutDeadline : 0);
  const details = { requirements, contracts, withoutDeadline };
  if (money.cmp(requirements, 0) > 0 && exceedsPct(withoutDeadline, requirements, maxNoDeadlinePct)) return degraded('EXIGENCIA_SEM_PRAZO', { ...details, maxNoDeadlinePct: String(maxNoDeadlinePct) });
  const dimensions = [{ key: 'contratos_qtd', value: contracts }];
  for (const r of rows.filter((x) => x.type !== ALL_TYPES).sort((a, b) => byText(a.type, b.type))) {
    dimensions.push({ key: `tipo:${r.type}`, value: money.count(r.requirements) }, { key: `tipo:${r.type}:contratos_qtd`, value: money.count(r.contracts) });
  }
  return { value: requirements, status: 'OK', details, dimensions };
}

const row = (type, contracts, requirements, withoutDeadline = 0) => ({ type, contracts, requirements, withoutDeadline });
const okOf = (req, con, without, dims) => ({ value: req, status: 'OK', details: { requirements: req, contracts: con, withoutDeadline: without }, dimensions: [{ key: 'contratos_qtd', value: con }, ...dims] });
const t = (type, req, con) => [{ key: `tipo:${type}`, value: req }, { key: `tipo:${type}:contratos_qtd`, value: con }];

const testCases = [
  { kind: 'empty', name: 'nenhuma exigência pendente: zero exigências em zero contratos', input: { rows: [] }, expected: okOf('0', '0', '0', []) },
  { kind: 'single', name: 'uma exigência em um contrato', input: { rows: [row('IDENTIFICATION', 1, 1), row(ALL_TYPES, 1, 1)] }, expected: okOf('1', '1', '0', t('IDENTIFICATION', '1', '1')) },
  {
    kind: 'typical', name: 'exemplo da demanda: 31 exigências em 12 contratos', input: { rows: [row('IDENTIFICATION', 9, 20), row('PROOF_OF_INCOME', 8, 11), row(ALL_TYPES, 12, 31)] },
    expected: okOf('31', '12', '0', [...t('IDENTIFICATION', '20', '9'), ...t('PROOF_OF_INCOME', '11', '8')]),
  },
  {
    kind: 'period_edge', name: 'limite elevado a 50%: 1 sem prazo em 2 não rebaixa', params: { maxNoDeadlinePct: 50 }, input: { rows: [row('X', 1, 2, 1), row(ALL_TYPES, 1, 2, 1)] },
    expected: okOf('2', '1', '1', t('X', '2', '1')),
  },
  { kind: 'rounding', name: 'contagens grandes exatas', input: { rows: [row(ALL_TYPES, '9007199254740993', '9007199254740995')] }, expected: okOf('9007199254740995', '9007199254740993', '0', []) },
  {
    kind: 'period_edge', name: 'exigência sem prazo (limite padrão 0): DEGRADED e sem valor', input: { rows: [row('X', 1, 2, 1), row(ALL_TYPES, 1, 2, 1)] },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'EXIGENCIA_SEM_PRAZO', requirements: '2', contracts: '1', withoutDeadline: '1', maxNoDeadlinePct: '0' }, dimensions: [] },
  },
  {
    kind: 'period_edge', name: 'campo ainda não recalculado pelo read model: DEGRADED', input: { rows: [row(ALL_TYPES, 1, 2, null)] },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'READ_MODEL_NAO_RECALCULADO', requirements: '2', contracts: '1' }, dimensions: [] },
  },
];

module.exports = { id: 'legal.missing_documents', version: 1, compute, testCases };
