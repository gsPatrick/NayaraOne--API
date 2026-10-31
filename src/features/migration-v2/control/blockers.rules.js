'use strict';

/** Códigos dos blockers da Torre (M9-D901 §3.3). Cada código vem da condição do item correspondente da migração v2. */
const CODES = Object.freeze({
  QUARANTINE_OPEN: 'GOV_MIG_QUARANTINE_OPEN', // (a) registros em quarentena
  REVIEW_PENDING: 'GOV_MIG_REVIEW_PENDING', // (b) registros esperando decisão humana
  RECONCILIATION_PENDING: 'GOV_MIG_RECONCILIATION_PENDING', // (c) reconciled < migrated
  HASH_MISMATCH: 'GOV_MIG_HASH_MISMATCH', // (d) lote com conteúdo diferente da origem
  BATCH_UNVERIFIED: 'GOV_MIG_BATCH_UNVERIFIED', // (d) lote aplicado e ainda não verificado
  TOTALS_INCONSISTENT: 'GOV_MIG_TOTALS_INCONSISTENT', // (g) contadores que não fecham
  RACI_INCOMPLETE: 'GOV_MIG_RACI_INCOMPLETE', // (h) atividade sem A ou sem R
});

const ownerLabel = (entry) => (entry ? (entry.userId ? `user:${entry.userId}` : `role:${entry.role}`) : null);
const accountableOf = (activity) => ownerLabel((activity && activity.entries || []).find((entry) => entry.raci === 'A'));

/**
 * Condições do estado atual, sem tocar no banco. `groups` vem de counters.service.summarize, `batchStates` são { source_system, entity, status, count, batch_ids } dos lotes
 * APPLIED e HASH_MISMATCH e `activities` é a matriz do RACI. Os demais blockers da lista 3.3 (comparação paralela, relógio e operação irreversível) entram por `extra`,
 * provedores registrados pelas demandas que os definem (M9-D903, M9-D908 e M9-D907).
 */
function evaluate({ groups, batchStates, activities, extra = [] }) {
  const reconciliation = activities.find((activity) => activity.code === 'FINAL_RECONCILIATION');
  const owner = accountableOf(reconciliation);
  const out = [];
  const add = (code, entity, ref, detail, who = owner) => out.push({ code, entity, ref, owner: who, detail });
  for (const g of groups) {
    const base = { source_system: g.source_system };
    if (g.totals.quarantined > 0) add(CODES.QUARANTINE_OPEN, g.entity, g.source_system, { ...base, count: g.totals.quarantined });
    if (g.totals.pending_review > 0) add(CODES.REVIEW_PENDING, g.entity, g.source_system, { ...base, count: g.totals.pending_review });
    if (g.totals.migrated > g.totals.reconciled) add(CODES.RECONCILIATION_PENDING, g.entity, g.source_system, { ...base, pending: g.totals.migrated - g.totals.reconciled, migrated: g.totals.migrated, reconciled: g.totals.reconciled });
    if (g.mismatches.length) add(CODES.TOTALS_INCONSISTENT, g.entity, g.source_system, { ...base, live_total: g.live_total, counters_sum: g.counters_sum, states: g.mismatches });
  }
  for (const b of batchStates) {
    const code = b.status === 'HASH_MISMATCH' ? CODES.HASH_MISMATCH : CODES.BATCH_UNVERIFIED;
    add(code, b.entity, b.source_system, { source_system: b.source_system, count: Number(b.count), batch_ids: b.batch_ids });
  }
  for (const activity of activities) {
    if (activity.complete) continue;
    add(CODES.RACI_INCOMPLETE, null, activity.code, { title: activity.title, phase: activity.phase, missing: activity.missing }, accountableOf(activity));
  }
  return [...out, ...extra];
}

module.exports = { CODES, evaluate, accountableOf };
