'use strict';

// Apoio dos testes M9-D903 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Estes testes COMMITAM dados; cada teste usa um sistema de origem exclusivo.
const { randomUUID } = require('node:crypto');
const env = require('./m9d901Env');
const targets = require('../../../src/features/migration-v2/ingest/targets');
const externalRefs = require('../../../src/features/migration-v2/externalRefs.service');
const windowService = require('../../../src/features/migration-v2/parallel/window.service');
const { tickWindow } = require('../../../src/features/migration-v2/parallel/runner');
const { runParallelCompare } = require('../../../src/features/migration-v2/parallel/parallel.job');

const { openTenantTx, q } = env;
const ENTITY = 'CONTRACT';
const COLUMN_MAP = Object.freeze({ vlr: 'amount', st: 'status', dt: 'due', nm: 'name' });
const RULES = Object.freeze([
  { entity: ENTITY, field: 'amount', rule: 'MONEY' },
  { entity: ENTITY, field: 'status', rule: 'ENUM_MAP', enumMap: { ATIVO: 'ACTIVE', ENCERRADO: 'CLOSED' } },
  { entity: ENTITY, field: 'due', rule: 'DATE' },
  { entity: ENTITY, field: 'name', rule: 'EXACT' },
]);
const T0 = new Date('2030-03-01T12:00:00Z');
const minutes = (n, from = T0) => new Date(from.getTime() + n * 60000);

/** Destino falso da entidade CONTRACT: o "novo" sistema guarda os campos canônicos em memória. */
function installNewSide() {
  const store = new Map();
  const target = {
    entityType: ENTITY,
    canonical: (row) => ({ amount: row.amount, status: row.status, due: row.due, name: row.name }),
    readCanonical: async (tenant, ids) => new Map(ids.filter((id) => store.has(id)).map((id) => [id, { ...store.get(id) }])),
    assess: async () => null, upsert: async () => null, markDeleted: async () => null,
  };
  return { store, restore: targets.overrideTarget(ENTITY, target) };
}

/** Cenário completo: fonte antiga falsa, destino falso e a janela criada pelo serviço (início e fim no futuro de T0). */
async function scenario(tenant, { rules = RULES, startMin = -60, endMin = 180, intervalMin = 60 } = {}) {
  const legacy = await env.installSource(tenant, { entity: ENTITY, columnMap: COLUMN_MAP });
  const side = installNewSide();
  const iso = (m) => minutes(m).toISOString();
  const window = await openTenantTx(tenant, (tx) => windowService.createWindow(tenant, { userId: tenant.userId }, {
    sourceSystem: legacy.system, entities: [ENTITY], startsAt: iso(startMin), endsAt: iso(endMin), intervalMin, rules,
  }, tx));
  /** Um registro nos dois lados: `old` com as colunas do legado, `now` com os campos canônicos do novo. */
  const pair = async (key, old, now) => {
    const id = randomUUID();
    side.store.set(id, { ...now });
    legacy.fake.row(key, T0, old);
    await openTenantTx(tenant, (tx) => externalRefs.register(tenant, { userId: tenant.userId }, { entityType: ENTITY, entityId: id, sourceSystem: legacy.system, sourceKey: key }, tx));
    return id;
  };
  /** Apaga a janela (em cascata regras, execuções e resultados), fecha na Torre os blockers que ela deixou e desfaz os falsos. */
  const dispose = async () => {
    await q('DELETE FROM governance.parallel_windows WHERE id = $1', [window.id]);
    await env.getTower(tenant, await env.newRun(tenant, legacy.system, ENTITY));
    side.restore();
    legacy.dispose();
  };
  return { legacy, side, window, pair, system: legacy.system, dispose };
}

const GOOD_OLD = { vlr: 125000, st: 'ATIVO', dt: '2030-05-10', nm: 'Contrato A' };
const GOOD_NEW = { amount: 125000, status: 'ACTIVE', due: '2030-05-10', name: 'Contrato A' };

const tick = (tenant, windowId, now) => tickWindow(tenant, windowId, { now, actor: { userId: tenant.userId } });
const results = (windowId) => q('SELECT * FROM governance.parallel_results WHERE window_id = $1 ORDER BY run_number, entity, source_key, field', [windowId]);
const runsOf = (windowId) => q('SELECT * FROM governance.parallel_runs WHERE window_id = $1 ORDER BY run_number', [windowId]);
const windowRow = async (id) => (await q('SELECT * FROM governance.parallel_windows WHERE id = $1', [id]))[0];
/** Blockers da comparação paralela que a Torre mostra para a fonte (a Torre também os grava e fecha). */
async function towerBlockers(tenant, system) {
  const runId = await env.newRun(tenant, system, ENTITY);
  return (await env.getTower(tenant, runId)).blockers.filter((b) => b.code.startsWith('GOV_PARALLEL_'));
}
const runJob = (tenant, now) => runParallelCompare(tenant, { now });

module.exports = { ...env, ENTITY, COLUMN_MAP, RULES, T0, minutes, scenario, GOOD_OLD, GOOD_NEW, tick, results, runsOf, windowRow, towerBlockers, runJob, windowService };
