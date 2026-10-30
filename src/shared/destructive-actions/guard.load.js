'use strict';

const inventory = require('./inventory');
const levels = require('./levels');
const shape = require('./impact.shape');
const { getProvider } = require('./registry');
const { readParams } = require('./confirmation.params');

const tenantOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId });

/** Carrega, numa transação do tenant, os parâmetros e o impacto atual do registro (calculado pelo servidor, nunca pelo cliente). */
async function loadImpact(req, key, { preview = false, id = req.params && req.params.id } = {}) {
  const entry = inventory.get(key);
  const tenant = tenantOf(req);
  const { params, loaded } = await req.withTenantTransaction(async (transaction) => {
    const p = await readParams(tenant, transaction);
    const result = await getProvider(key)({ id, params: req.params || {}, query: req.query || {}, body: req.body, tenant, transaction, preview, req, itemsMax: p.itemsMax });
    return { params: p, loaded: result };
  });
  if (!preview && loaded && loaded.skip) return { skip: true };
  const impact = shape.normalize(loaded.impact);
  impact.items = impact.items.slice(0, params.itemsMax);
  return {
    entry, tenant, params, id, impact,
    level: levels.effectiveLevel(key, params.levelsText),
    code: loaded.code == null ? '' : String(loaded.code),
    label: loaded.label || null,
  };
}

module.exports = { loadImpact, tenantOf };
