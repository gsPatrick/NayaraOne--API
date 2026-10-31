'use strict';

// Apoio dos testes M9-D904 (não é teste): janela de comparação paralela (M9-D903) sobre uma entidade EXCLUSIVA do teste, para não herdar o que outros testes deixam em CONTRACT.
const { randomUUID } = require('node:crypto');
const env = require('./m9d904Env');
const targets = require('../../../src/features/migration-v2/ingest/targets');
const externalRefs = require('../../../src/features/migration-v2/externalRefs.service');

const ENTITY = 'PROJECT_STAGE'; // entidade de migração (check de mig_sources) que nenhum outro teste usa
const COLUMN_MAP = Object.freeze({ nm: 'name' });
const RULES = Object.freeze([{ entity: ENTITY, field: 'name', rule: 'EXACT' }]);
const iso = (m) => env.minutes(m).toISOString();

/** Cenário: origem antiga falsa, destino novo falso (em memória) e a janela criada pelo serviço. `pair(chave, nomeAntigo, nomeNovo)` põe um registro nos dois lados. */
async function comparisonScenario(tenant) {
  const legacy = await env.installSource(tenant, { entity: ENTITY, columnMap: COLUMN_MAP });
  const store = new Map();
  const restore = targets.overrideTarget(ENTITY, {
    entityType: ENTITY, canonical: (row) => ({ name: row.name }), assess: async () => null, upsert: async () => null, markDeleted: async () => null,
    readCanonical: async (_tenant, ids) => new Map(ids.filter((id) => store.has(id)).map((id) => [id, { ...store.get(id) }])),
  });
  const window = await env.openTenantTx(tenant, (tx) => env.windowService.createWindow(tenant, { userId: tenant.userId }, {
    sourceSystem: legacy.system, entities: [ENTITY], startsAt: iso(-60), endsAt: iso(180), intervalMin: 60, rules: RULES,
  }, tx));
  const pair = async (key, oldName, newName) => {
    const id = randomUUID();
    store.set(id, { name: newName });
    legacy.fake.row(key, env.T0, { nm: oldName });
    await env.openTenantTx(tenant, (tx) => externalRefs.register(tenant, { userId: tenant.userId }, { entityType: ENTITY, entityId: id, sourceSystem: legacy.system, sourceKey: key }, tx));
    return id;
  };
  const dispose = async () => {
    await env.q('DELETE FROM governance.parallel_windows WHERE id = $1', [window.id]);
    await env.getTower(tenant, await env.newRun(tenant, legacy.system, ENTITY));
    restore();
    legacy.dispose();
  };
  return { ENTITY, window, store, pair, dispose };
}

module.exports = { ENTITY, comparisonScenario };
