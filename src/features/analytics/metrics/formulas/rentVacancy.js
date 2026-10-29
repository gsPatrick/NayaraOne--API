'use strict';

/**
 * M9-D640 — KPI rent.vacancy (Vacância), versão 1. Posição no fim do dia-base, em percentual com 2 casas, arredondado uma vez:
 *   vacância = imóveis locáveis sem contrato ACTIVE na data-base ÷ imóveis locáveis × 100   (suspensos contam como sem contrato ativo e saem à parte em suspensos_qtd)
 * Imóvel locável = o da regra de rentable.sql.js (finalidade de locação ativa no portfólio). Entrada (rm_rental_vacancy, linha da data-base): { row: { rentableTotal, rentedTotal,
 * suspendedTotal, vacantTotal, statusUndefined, byType, byNeighborhood, byOwner } | null }; cada grupo é { chave: { rentable, rented } }. Modo de reconciliação (M9-D611): as linhas dos
 * imóveis locáveis [{ rented }] refazem a conta. Regra de qualidade: imóvel com oferta de locação ou contrato e situação vazia ou desconhecida -> DEGRADED; total locável zero -> INCOMPLETE;
 * retrato ainda não calculado -> DEGRADED. Valor sempre nulo nesses casos.
 */
const money = require('./money');
const { degraded, incomplete, byText } = require('./_legalCorKpi');

const FIELDS = ['rentableTotal', 'rentedTotal', 'suspendedTotal', 'vacantTotal', 'statusUndefined'];
const share = (rentable, rented) => money.percent(money.sub(rentable, rented), rentable);

function fromRows(list) {
  const rented = list.filter((r) => ['true', 't'].includes(String(r.rented))).length; // o texto do booleano que o banco devolve
  return { value: share(list.length, rented).value, status: list.length ? 'OK' : 'INCOMPLETE', details: {}, dimensions: [] };
}

const groupDimensions = (prefix, map) => Object.keys(map || {}).sort(byText).map((k) => ({ key: `${prefix}:${k}`, value: share(map[k].rentable, map[k].rented).value || '0.00' }));

function compute(input) {
  if (Array.isArray(input)) return fromRows(input);
  const row = input.row;
  if (!row || FIELDS.some((f) => row[f] === null || row[f] === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const [rentable, rented, suspended, vacant, undefinedStatus] = FIELDS.map((f) => money.count(row[f]));
  if (undefinedStatus !== '0') return degraded('IMOVEL_SEM_SITUACAO', { statusUndefined: undefinedStatus, rentable });
  if (rentable === '0') return incomplete('TOTAL_LOCAVEL_ZERO', { rentable });
  const dimensions = [
    { key: 'locaveis_qtd', value: rentable }, { key: 'alugados_qtd', value: rented }, { key: 'suspensos_qtd', value: suspended }, { key: 'vagos_qtd', value: vacant },
    ...groupDimensions('tipo', row.byType), ...groupDimensions('bairro', row.byNeighborhood), ...groupDimensions('proprietario', row.byOwner),
  ];
  return { value: share(rentable, rented).value, status: 'OK', details: { rentable, rented, suspended, vacant }, dimensions };
}

const mk = (rentable, rented, suspended, vacant, extra = {}) => ({ row: { rentableTotal: rentable, rentedTotal: rented, suspendedTotal: suspended, vacantTotal: vacant, statusUndefined: 0, byType: {}, byNeighborhood: {}, byOwner: {}, ...extra } });
const okOf = (value, rentable, rented, suspended, vacant, extra = []) => ({
  value, status: 'OK', details: { rentable, rented, suspended, vacant },
  dimensions: [{ key: 'locaveis_qtd', value: rentable }, { key: 'alugados_qtd', value: rented }, { key: 'suspensos_qtd', value: suspended }, { key: 'vagos_qtd', value: vacant }, ...extra],
});
const lost = 'Dado incompleto, valor não confiável.';
const noValue = (status, reason, details) => ({ value: null, status, message: lost, details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhum imóvel locável: INCOMPLETE e sem valor (nunca 0%)', input: mk(0, 0, 0, 0), expected: noValue('INCOMPLETE', 'TOTAL_LOCAVEL_ZERO', { rentable: '0' }) },
  { kind: 'single', name: 'um imóvel locável e alugado: 0,00%', input: mk(1, 1, 0, 0), expected: okOf('0.00', '1', '1', '0', '0') },
  {
    kind: 'typical', name: 'exemplo do livro: 91 locáveis, 85 alugados, 6 vagos => 6,59%; por tipo, bairro e proprietário',
    input: mk(91, 85, 0, 6, { byType: { APARTAMENTO: { rentable: 60, rented: 56 }, CASA: { rentable: 31, rented: 29 } }, byNeighborhood: { Centro: { rentable: 91, rented: 85 } }, byOwner: { o1: { rentable: 2, rented: 1 } } }),
    expected: okOf('6.59', '91', '85', '0', '6', [
      { key: 'tipo:APARTAMENTO', value: '6.67' }, { key: 'tipo:CASA', value: '6.45' }, { key: 'bairro:Centro', value: '6.59' }, { key: 'proprietario:o1', value: '50.00' },
    ]),
  },
  { kind: 'period_edge', name: 'imóvel com contrato suspenso conta como sem contrato ativo e aparece em suspensos_qtd', input: mk(10, 8, 1, 1), expected: okOf('20.00', '10', '8', '1', '1') },
  { kind: 'rounding', name: '1 ÷ 3 => 33,33% e 2 ÷ 3 => 66,67% (meio para cima, uma vez)', input: mk(3, 1, 0, 2), expected: okOf('66.67', '3', '1', '0', '2') },
  { kind: 'period_edge', name: 'imóvel com oferta de locação e situação desconhecida: DEGRADED e sem valor', input: mk(10, 5, 0, 5, { statusUndefined: 2 }), expected: noValue('DEGRADED', 'IMOVEL_SEM_SITUACAO', { statusUndefined: '2', rentable: '10' }) },
  { kind: 'period_edge', name: 'retrato do dia ainda não calculado: DEGRADED e sem valor', input: { row: null }, expected: noValue('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', {}) },
  { kind: 'period_edge', name: 'reconciliação sobre as linhas dos locáveis: 3 de 4 alugados => 25,00%', input: [{ rented: 'true' }, { rented: 'true' }, { rented: 'true' }, { rented: 'false' }], expected: { value: '25.00', status: 'OK', details: {}, dimensions: [] } },
];

module.exports = { id: 'rent.vacancy', version: 1, compute, testCases };
