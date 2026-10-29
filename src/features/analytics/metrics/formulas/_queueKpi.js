'use strict';

/**
 * M9-D709 — peça comum das fórmulas das quatro filas de decisão (fin.approvals_pending, inv.adjustments_pending, tec.rule_approvals_pending,
 * ai.proposals_pending). Posição: conta os itens da fila que, no instante da leitura (`input.asOfInstant`), esperam decisão (pendentes, ou decididos
 * depois dele), soma o valor em BRL das filas que têm valor e separa os "envelhecidos" (idade em horas acima de `params.agedHours`). Regra de qualidade
 * violada em qualquer item pendente → INCOMPLETE, sem valor (nunca um número enganoso, BI-015). Decimal exato, arredondado uma só vez, sem relógio nem banco.
 * Entrada: { asOfInstant, rows: [{ status, requested_at, decided_at, amount, ...campos da fila }] }; parâmetros: { agedHours }.
 */
const money = require('./money');
const { INCOMPLETE_MESSAGE, incomplete } = require('./_obraEstoqueKpi');

const HOUR_MS = 3600000n;
const UNKNOWN = 'NAO_INFORMADO';

/** O item espera decisão no instante: pedido até ele e ainda pendente, ou decidido/cancelado só depois dele. */
function isOpenAt(row, instantMs) {
  const requested = row.requested_at ? Date.parse(row.requested_at) : null;
  if (requested !== null && requested > instantMs) return false;
  if (row.status === 'PENDING') return true;
  return row.decided_at ? Date.parse(row.decided_at) > instantMs : false;
}

/** Horas inteiras (para baixo) desde o pedido, em texto decimal; instante antes do pedido dá zero. Divisão inteira em BigInt: sem ponto flutuante. */
function hoursOld(row, instantMs) {
  if (!row.requested_at) return null;
  const diff = BigInt(instantMs - Date.parse(row.requested_at));
  return diff <= 0n ? '0' : String(diff / HOUR_MS);
}
const labelOf = (value) => (value === null || value === undefined || value === '' ? UNKNOWN : String(value).replace(/[:=]/g, '_'));

/** spec: { incomplete(row) -> motivo|null, amount: boolean, groups: [{ name, of(row) }] }. */
function computeQueue(input, params, spec) {
  const instant = Date.parse(input.asOfInstant);
  const open = (input.rows || []).filter((row) => isOpenAt(row, instant));
  const reasons = open.map((row) => spec.incomplete(row)).filter(Boolean);
  const aged = open.filter((row) => { const h = hoursOld(row, instant); return h !== null && money.cmp(h, params.agedHours) > 0; });
  const details = { count: money.count(open.length), aged: money.count(aged.length), agedHours: money.count(params.agedHours) };
  if (spec.amount) details.amount = money.money(money.sum(open.map((row) => row.amount || 0)));
  if (reasons.length) return incomplete(reasons[0], { ...details, incomplete: money.count(reasons.length) }, []);
  const dimensions = [{ key: 'envelhecidas_qtd', value: details.aged }];
  if (spec.amount) dimensions.push({ key: 'valor_brl', value: details.amount });
  for (const group of spec.groups) {
    const counts = new Map();
    for (const row of open) { const id = labelOf(group.of(row)); counts.set(id, (counts.get(id) || 0) + 1); }
    for (const [id, n] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) dimensions.push({ key: `${group.name}:${id}`, value: money.count(n) });
  }
  return { value: details.count, status: 'OK', details, dimensions };
}

module.exports = { computeQueue, isOpenAt, hoursOld, INCOMPLETE_MESSAGE };
