'use strict';

/**
 * M9-D625 (3.2, 3.3) — eliminação do intercompany na LEITURA. Lê, no read model das transferências entre empresas, as transferências aprovadas das empresas
 * do consolidado (cada empresa sob o seu próprio contexto de RLS) e:
 *  - só considera transferência cujas DUAS pontas estão no consolidado (a que sai do conjunto é fluxo externo e não se elimina);
 *  - par incompleto (um lado só ou valores diferentes) NUNCA é eliminado por aproximação: vai para `unmatched` e o consolidado fica DEGRADED;
 *  - par completo é eliminado nos dois lados conforme a regra do indicador (fluxo liquidado no período, ou posição pendente nas duas pontas).
 * Datas de calendário de São Paulo. Dinheiro em decimal exato.
 */
const { businessDateKey } = require('../../../../utils/businessDate');
const money = require('../formulas/money');
const { readIntercompanyPairs } = require('../../read-models');
const { inCompany } = require('./companyAccess');

const spDay = (value) => (value ? businessDateKey(new Date(value)) : null);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Linhas do read model das empresas do consolidado: [{ ...linha, origin_company_id }]. */
async function loadPairs(ctx, companyIds, transaction) {
  const out = [];
  for (const companyId of companyIds) {
    const rows = await inCompany(companyId, ctx.companyId, transaction, () => readIntercompanyPairs(ctx, companyId, transaction));
    out.push(...rows);
  }
  return out;
}

/** Pares inteiros do consolidado e a lista dos incompletos ({ transferId, lado, valor }: o lado que existe, SAIDA ou ENTRADA). */
function classify(pairs, companyIds) {
  const inside = new Set(companyIds);
  const complete = [];
  const unmatched = [];
  for (const p of pairs.filter((x) => inside.has(x.origin_company_id) && inside.has(x.to_company_id))) {
    if (p.pair_state === 'MATCHED') { complete.push(p); continue; }
    if (p.pair_state === 'ONLY_FROM' || p.pair_state === 'AMOUNT_MISMATCH') unmatched.push({ transferId: p.transfer_id, lado: 'SAIDA', valor: money.money(p.from_amount) });
    if (p.pair_state === 'ONLY_TO' || p.pair_state === 'AMOUNT_MISMATCH') unmatched.push({ transferId: p.transfer_id, lado: 'ENTRADA', valor: money.money(p.to_amount) });
  }
  return { complete, unmatched };
}

function inPeriod(day, period) {
  return Boolean(day) && day >= period.from && day <= period.to;
}

function inDueWindow(day, window, asOfDate) {
  if (!window) return true;
  if (!day) return false;
  if (window.fromDays !== null && window.fromDays !== undefined && day < addDays(asOfDate, window.fromDays)) return false;
  return !(window.toDays !== null && window.toDays !== undefined && day > addDays(asOfDate, window.toDays));
}

/** O par entra na eliminação do indicador? (as duas pontas liquidadas dentro do período, ou as duas pendentes dentro da janela de vencimento) */
function eliminates(pair, intercompany, { period, asOfDate }) {
  if (!intercompany || intercompany.side === 'NONE') return false;
  if (intercompany.phase === 'SETTLED') {
    return pair.from_entry_status === 'SETTLED' && pair.to_entry_status === 'SETTLED' && inPeriod(spDay(pair.from_settled_at), period) && inPeriod(spDay(pair.to_settled_at), period);
  }
  if (pair.from_entry_status !== 'PENDING' || pair.to_entry_status !== 'PENDING') return false;
  const due = intercompany.side === 'IN' ? pair.to_due_at : pair.from_due_at;
  return inDueWindow(spDay(due), intercompany.dueWindow, asOfDate);
}

/** { eliminations: texto decimal, eliminatedPairs: nº de pares eliminados, unmatched } para a regra do indicador. `period` = { from, to } (AAAA-MM-DD). */
function eliminate(pairs, companyIds, intercompany, { period, asOfDate }) {
  const { complete, unmatched } = classify(pairs, companyIds);
  const hit = complete.filter((p) => eliminates(p, intercompany, { period, asOfDate }));
  return { eliminations: money.money(money.sum(hit.map((p) => p.amount))), eliminatedPairs: hit.length, unmatched };
}

module.exports = { loadPairs, classify, eliminate, eliminates, spDay };
