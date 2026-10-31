'use strict';

const repo = require('./counters.repository');

const COUNTER_KEYS = ['total', 'migrated', 'reconciled', 'quarantined', 'pending_review', 'excluded', 'not_started'];
const emptyTotals = () => Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0]));

/** Soma uma linha (estado, valor dos contadores) nos seis indicadores do livro (M9-D901 §3.2). `total` é a contagem direta; os demais vêm dos contadores materializados. */
function addState(totals, state, counter) {
  const n = Number(counter);
  if (state === 'MIGRATED' || state === 'RECONCILED') totals.migrated += n;
  if (state === 'RECONCILED') totals.reconciled += n;
  if (state === 'QUARANTINED') totals.quarantined += n;
  if (state === 'PENDING_REVIEW') totals.pending_review += n;
  if (state === 'EXCLUDED') totals.excluded += n;
  if (state === 'PENDING') totals.not_started += n;
}

/**
 * Indicadores por sistema/entidade e as divergências (contador diferente da contagem direta, contador negativo, reconciliado maior que migrado). Retorna
 * { rows, groups }, onde cada grupo é { source_system, entity, totals, live_total, counters_sum, mismatches }.
 */
function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.source_system}|${row.entity}`;
    if (!groups.has(key)) groups.set(key, { source_system: row.source_system, entity: row.entity, totals: emptyTotals(), live_total: 0, counters_sum: 0, mismatches: [] });
    const group = groups.get(key);
    addState(group.totals, row.state, row.counter);
    group.live_total += Number(row.live);
    group.counters_sum += Number(row.counter);
    if (Number(row.counter) !== Number(row.live) || Number(row.counter) < 0) group.mismatches.push({ state: row.state, counter: Number(row.counter), live: Number(row.live) });
  }
  for (const group of groups.values()) {
    group.totals.total = group.live_total;
    if (group.totals.reconciled > group.totals.migrated && !group.mismatches.length) group.mismatches.push({ state: 'RECONCILED', counter: group.totals.reconciled, live: group.totals.migrated });
  }
  return [...groups.values()];
}

/** Junta os grupos do escopo (sistema e/ou entidade) no total e por entidade. */
function aggregate(groups, scope) {
  const inScope = groups.filter((g) => (!scope.sourceSystem || g.source_system === scope.sourceSystem) && (!scope.entity || g.entity === scope.entity));
  const totals = emptyTotals();
  const byEntity = {};
  for (const group of inScope) {
    byEntity[group.entity] = byEntity[group.entity] || emptyTotals();
    for (const key of COUNTER_KEYS) { totals[key] += group.totals[key]; byEntity[group.entity][key] += group.totals[key]; }
  }
  const bad = inScope.filter((g) => g.mismatches.length);
  const sum = totals.migrated + totals.quarantined + totals.pending_review + totals.excluded + totals.not_started;
  const invariants = {
    ok: bad.length === 0 && totals.total === sum && totals.reconciled <= totals.migrated, total_equals_sum: totals.total === sum, reconciled_le_migrated: totals.reconciled <= totals.migrated,
    mismatches: bad.map((g) => ({ source_system: g.source_system, entity: g.entity, states: g.mismatches })),
  };
  return { totals, byEntity, invariants, groups: inScope };
}

/** Job de conferência (M9-D901 §6): detecta divergência e, só então, refaz os contadores. Devolve { corrected }. */
async function recount(tenant, transaction) {
  const before = summarize(await repo.readSideBySide(tenant, transaction));
  if (!before.some((g) => g.mismatches.length)) return { corrected: 0 };
  return { corrected: await repo.rebuild(tenant, transaction) };
}

module.exports = { COUNTER_KEYS, emptyTotals, summarize, aggregate, recount };
