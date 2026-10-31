'use strict';

const { computeBlockers } = require('../control/tower.service');
const params = require('./canary.params');
const comparison = require('./canary.comparison');
const targets = require('../ingest/targets');
const errors = require('./canary.errors');

const BLOCKERS_SHOWN = 20;
// Blockers do corte inteiro, que travam o avanço de TODOS os setores, tenham ou não entidade: RACI incompleto (M9-D902), relógio fora do limite (M9-D908 §3.5) e operação externa
// sem plano de compensação ou com compensação pendente (M9-D907).
const GLOBAL_CODES = Object.freeze(['GOV_MIG_RACI_INCOMPLETE', 'GOV_MIG_CLOCK_DRIFT', 'GOV_MIG_CLOCK_UNMEASURED', 'GOV_ROLLBACK_COMPENSATION_REQUIRED', 'GOV_ROLLBACK_PENDING']);

/**
 * Entidades que o avanço do setor considera: as do parâmetro `migracao.setor.<setor>.entidades` mais toda entidade que a migração real carrega por algum destino (PERSON,
 * SUPPLIER, PROPERTY...). Esses cadastros são a base de todos os setores e não pertencem a um só; sem isso o gate ignorava a migração real com a configuração padrão.
 */
const gateEntities = (sectorEntities) => [...new Set([...sectorEntities, ...targets.ENTITIES()])];

/** Blockers abertos da Torre (M9-D901) que travam o setor: entidade do gate (acima) ou blocker do corte inteiro (GLOBAL_CODES). */
async function sectorBlockers(tenant, sector, transaction) {
  const entities = gateEntities(await params.readEntities(tenant, sector, transaction));
  const { blockers } = await computeBlockers(tenant, {}, transaction);
  return { entities, blockers: blockers.filter((blocker) => GLOBAL_CODES.includes(blocker.code) || (blocker.entity && entities.includes(String(blocker.entity).toUpperCase()))) };
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
