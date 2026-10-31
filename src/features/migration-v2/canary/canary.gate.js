'use strict';

const { computeBlockers } = require('../control/tower.service');
const params = require('./canary.params');
const comparison = require('./canary.comparison');
const errors = require('./canary.errors');

const BLOCKERS_SHOWN = 20;

/** Blockers abertos da Torre (M9-D901) que pertencem ao setor: o `entity` do blocker está na lista `migracao.setor.<setor>.entidades`. Blocker sem entidade não é de setor nenhum. */
async function sectorBlockers(tenant, sector, transaction) {
  const entities = await params.readEntities(tenant, sector, transaction);
  const { blockers } = await computeBlockers(tenant, {}, transaction);
  return { entities, blockers: blockers.filter((blocker) => blocker.entity && entities.includes(String(blocker.entity).toUpperCase())) };
}

/** Condição do avanço (M9-D904 §3.3): zero blockers do setor na Torre e a última comparação paralela limpa. */
async function assertCanAdvance(tenant, sector, transaction) {
  const { entities, blockers } = await sectorBlockers(tenant, sector, transaction);
  if (blockers.length) {
    throw errors.blockersOpen({ sector, count: blockers.length, blockers: blockers.slice(0, BLOCKERS_SHOWN).map(({ code, entity, ref }) => ({ code, entity, ref })) });
  }
  await comparison.assertClean(tenant, entities, { requireComparison: await params.readRequireComparison(tenant, transaction) }, transaction);
}

module.exports = { sectorBlockers, assertCanAdvance };
