'use strict';

const { ENTITY_TYPES } = require('./merge.constants');
const { SCAN_BATCH } = require('./quality.constants');
const { listLiveIds } = require('./quality.loader');
const { evaluateEntities } = require('./quality.evaluate');
const lifecycle = require('./stewardship.lifecycle');

/**
 * Varredura da empresa (job noturno dataQualityScanJob, M9-D806 §3.3): avalia todos os cadastros vivos de PERSON, PROPERTY e SUPPLIER, por lotes de
 * id, e depois chama notifyPendingDomains (M9-D804): um aviso IN_APP por domínio pendente e por dia ao administrador.
 */
async function scanCompany(tenant, transaction, { entityTypes = ENTITY_TYPES, now = new Date() } = {}) {
  const summary = { evaluated: 0, opened: 0, resolved: 0, byEntity: {} };
  for (const entityType of entityTypes) {
    let afterId = null;
    const counts = { evaluated: 0, opened: 0, resolved: 0 };
    for (;;) {
      const ids = await listLiveIds(tenant, entityType, afterId, SCAN_BATCH, transaction);
      if (!ids.length) break;
      const results = await evaluateEntities(tenant, entityType, ids, transaction, { now });
      results.forEach((result) => { counts.evaluated += 1; counts.opened += result.opened.length; counts.resolved += result.resolved.length; });
      afterId = ids[ids.length - 1];
    }
    summary.byEntity[entityType] = counts;
    summary.evaluated += counts.evaluated; summary.opened += counts.opened; summary.resolved += counts.resolved;
  }
  summary.domains = await lifecycle.notifyPendingDomains(tenant, transaction, now);
  return summary;
}

module.exports = { scanCompany };
