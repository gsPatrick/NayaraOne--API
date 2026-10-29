'use strict';

/**
 * M9-D641 — KPI rent.inspections_keys (Vistorias e chaves), versão 1. Posição no fim do dia-base: vistorias de contratos de locação pendentes (agendadas e não realizadas) e atrasadas
 * (data prevista anterior a hoje, em São Paulo); chaves entregues e não devolvidas (contrato ACTIVE) e atrasadas (devolução prevista, o fim do contrato, anterior a hoje). O valor é a
 * contagem de vistorias pendentes; atrasadas, chaves fora e chaves atrasadas vão em details e nas dimensões. Entrada (rm_rental_inspections_keys, linha do dia-base): { row: {
 * inspectionsPending, inspectionsOverdue, keysOut, keysReturnOverdue, keysWithoutReturnDate } | null }. Regra de qualidade: chave sem data prevista -> DEGRADED; retrato do dia ainda
 * não calculado ou campo nulo -> DEGRADED. Valor sempre nulo nesses casos.
 */
const money = require('./money');
const { degraded } = require('./_legalCorKpi');

const FIELDS = ['inspectionsPending', 'inspectionsOverdue', 'keysOut', 'keysReturnOverdue', 'keysWithoutReturnDate'];

function compute(input) {
  const row = input.row;
  if (!row || FIELDS.some((f) => row[f] === null || row[f] === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const [pending, overdue, keysOut, keysOverdue, withoutDate] = FIELDS.map((f) => money.count(row[f]));
  if (money.cmp(withoutDate, 0) > 0) return degraded('CHAVE_SEM_DATA_PREVISTA', { keysWithoutReturnDate: withoutDate, keysOut });
  return {
    value: pending, status: 'OK', details: { inspectionsPending: pending, inspectionsOverdue: overdue, keysOut, keysOverdue },
    dimensions: [{ key: 'vistorias_atrasadas_qtd', value: overdue }, { key: 'chaves_fora_qtd', value: keysOut }, { key: 'chaves_atrasadas_qtd', value: keysOverdue }],
  };
}

const mk = (a, b, c, d, e = 0) => ({ row: { inspectionsPending: a, inspectionsOverdue: b, keysOut: c, keysReturnOverdue: d, keysWithoutReturnDate: e } });
const okOf = (a, b, c, d) => ({
  value: a, status: 'OK', details: { inspectionsPending: a, inspectionsOverdue: b, keysOut: c, keysOverdue: d },
  dimensions: [{ key: 'vistorias_atrasadas_qtd', value: b }, { key: 'chaves_fora_qtd', value: c }, { key: 'chaves_atrasadas_qtd', value: d }],
});
const bad = (reason, details) => ({ value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma vistoria nem chave: zeros', input: mk(0, 0, 0, 0), expected: okOf('0', '0', '0', '0') },
  { kind: 'single', name: 'uma vistoria pendente atrasada', input: mk(1, 1, 0, 0), expected: okOf('1', '1', '0', '0') },
  { kind: 'typical', name: 'exemplo da demanda: vistorias pendentes 9, atrasadas 3; chaves fora 12, atrasadas 2', input: mk(9, 3, 12, 2), expected: okOf('9', '3', '12', '2') },
  { kind: 'period_edge', name: 'chave sem data prevista de devolução: DEGRADED e sem valor', input: mk(9, 3, 12, 2, 1), expected: bad('CHAVE_SEM_DATA_PREVISTA', { keysWithoutReturnDate: '1', keysOut: '12' }) },
  { kind: 'rounding', name: 'contagens grandes somam exatas (sem ponto flutuante)', input: mk('9007199254740993', 0, '9007199254740994', 0), expected: okOf('9007199254740993', '0', '9007199254740994', '0') },
  { kind: 'period_edge', name: 'retrato do dia ainda não calculado pelo read model: DEGRADED e sem valor', input: { row: null }, expected: bad('READ_MODEL_NAO_RECALCULADO', {}) },
];

module.exports = { id: 'rent.inspections_keys', version: 1, compute, testCases };
