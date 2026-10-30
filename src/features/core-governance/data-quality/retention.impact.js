'use strict';

const runRepository = require('./retention.run.repository');
const holdGuard = require('./retention.holdGuard');
const { assertApplicable } = require('./retention.apply.state');
const targets = require('./retention.targets');
const errors = require('./retention.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;
const shortCode = (id) => `RET-${String(id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/** Quantos dos itens PENDING do alvo estão sob legal hold AGORA (a reconferência do apply pularia esses). */
async function heldNow(tenant, runId, target, transaction) {
  if (targets.isFunction(target)) return (await holdGuard.heldIds(target.holdEntityType, [tenant.companyId], { tenant, transaction })).length;
  let held = 0; let after = '';
  for (;;) {
    const ids = await runRepository.pendingIds(runId, target.code, { after, limit: PAGE }, transaction);
    if (!ids.length) return held;
    held += (await holdGuard.heldIds(target.holdEntityType, ids, { tenant, transaction })).length;
    after = ids[ids.length - 1];
  }
}

/**
 * Provedor de impacto da linha 10 do inventário da M9-D852 (retention.apply): contagem por tabela do que ainda será descartado, valor monetário envolvido (centavos),
 * impedimentos (tudo sob hold) e o código a digitar (o da rodada). Rodada sem simulação válida, já aplicada ou em aplicação recusa com o erro do livro.
 */
async function impactOf(tenant, runId, transaction, now = new Date()) {
  if (!UUID.test(String(runId))) throw errors.dryRunRequired();
  const run = await runRepository.getRun(tenant, runId, transaction);
  await assertApplicable(tenant, run, transaction, now);
  const byState = await runRepository.stateCounts(runId, transaction);
  const byTable = {}; let pending = 0; let held = 0; let totalAmountCents = 0;
  for (const [code, states] of Object.entries(byState)) {
    const target = targets.get(code);
    const n = states.PENDING || 0;
    if (!n) continue;
    const label = targets.isFunction(target) ? 'integration.purge_expired()' : `${target.schema}.${target.table}`;
    byTable[label] = n; pending += n;
    held += await heldNow(tenant, runId, target, transaction);
    totalAmountCents += await runRepository.pendingAmountCents(runId, target, transaction);
  }
  const blockers = pending > 0 && held >= pending ? [{ code: 'GOV_RETENTION_ALL_HELD', message: 'Todos os registros desta rodada estão sob bloqueio legal (legal hold).' }] : [];
  const items = Object.entries(byTable).map(([id, n]) => ({ type: 'TABLE', id, label: `${id}: ${n}` }));
  return { code: shortCode(runId), label: 'Rodada de retenção', impact: { counts: { pending, heldNow: held, byTable }, totalAmountCents, blockers, items } };
}

/** Provedor registrado na M9-D852: o impacto é o da rodada do :id. */
async function retentionApplyProvider({ id, tenant, transaction }) {
  return impactOf(tenant, id, transaction);
}

module.exports = { impactOf, retentionApplyProvider, shortCode };
