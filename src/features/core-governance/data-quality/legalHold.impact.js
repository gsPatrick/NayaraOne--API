'use strict';

const repository = require('./legalHold.repository');
const derive = require('./legalHold.derive');
const errors = require('./legalHold.errors');
const { isUuid } = require('./legalHold.input');
const { STATUS, COMPANY } = require('./legalHold.constants');

/**
 * Provedor de impacto da linha 11 do inventário da M9-D852 (legal_hold.release): o que deixa de estar retido. Recalcula o escopo antes de contar (os registros que passaram a
 * cair nele depois da criação entram), então o número é o de agora. Retenção já liberada é impedimento. O código a digitar é o da retenção.
 */
async function impactOf(tenant, id, transaction) {
  const hold = isUuid(id) ? await repository.findById(tenant, id, transaction) : null;
  if (!hold) throw errors.notFound();
  if (hold.status === STATUS.ACTIVE) await derive.expand(hold, transaction);
  const byType = await repository.countTargets(hold.id, transaction);
  const counts = { targets: byType.reduce((sum, row) => sum + row.count, 0), byType: Object.fromEntries(byType.map((row) => [row.entityType, row.count])) };
  const blockers = hold.status === STATUS.RELEASED ? [{ code: 'GOV_HOLD_ALREADY_RELEASED', message: 'Esta retenção legal já foi liberada.' }] : [];
  const items = byType.map((row) => ({ type: row.entityType, id: row.entityType, label: row.entityType === COMPANY ? 'Empresa inteira' : `${row.entityType}: ${row.count}` }));
  return { code: hold.code, label: `Retenção legal ${hold.code}`, impact: { counts, totalAmountCents: 0, blockers, items } };
}

async function legalHoldReleaseProvider({ id, tenant, transaction }) {
  return impactOf(tenant, id, transaction);
}

module.exports = { impactOf, legalHoldReleaseProvider };
