'use strict';

// M9-D900 (reabertura, auditoria L4 e L7): descarte do conteúdo de origem depois da reconciliação e replay que devolve o mesmo hash. Banco descartável.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d900Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { purgePayloads } = require('../../../src/features/migration-v2/ingest/payload.purge');
const { replayBatch } = require('../../../src/features/migration-v2/ingest/replay');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const A = () => tenants.A;
const DAYS = 'migracao.payload.retencao_dias';
const setSetting = (key, value) => env.openTenantTx(A(), (tx) => upsertSetting(key, value, A(), A().userId, tx));
const purge = () => env.openTenantTx(A(), (tx) => purgePayloads(A(), tx));
const payloads = async (system) => (await env.recordsOf(system)).map((r) => [r.source_key, r.state, r.source_payload !== null]);

before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => { if (env.DISPOSABLE) await setSetting(DAYS, 30); });
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });

async function loaded() {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  for (let i = 1; i <= 3; i += 1) legacy.fake.event(`${i}`, 'I', i, env.personRecord());
  await env.run(A(), { sourceSystem: legacy.system });
  return legacy;
}

test('m9d900 o descarte tira o conteúdo só de registro RECONCILED mais velho que o prazo', { skip: skip() }, async () => {
  const legacy = await loaded();
  await env.adminQuery("UPDATE governance.mig_records SET state = 'RECONCILED', updated_at = now() - interval '40 days' WHERE source_system = $1 AND source_key = '1'", [legacy.system]);
  await env.adminQuery("UPDATE governance.mig_records SET state = 'RECONCILED' WHERE source_system = $1 AND source_key = '2'", [legacy.system]);
  await purge();
  assert.deepEqual(await payloads(legacy.system), [['1', 'RECONCILED', false], ['2', 'RECONCILED', true], ['3', 'MIGRATED', true]], 'velho e reconciliado sai; recente e não reconciliado ficam');
  const [kept] = await env.recordsOf(legacy.system);
  assert.ok(kept.row_hash && kept.target_entity_id, 'hash e referência ao destino permanecem');
  const [audit] = await env.q("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = $1 AND action = 'migration.payload.purged'", [A().companyId]);
  assert.ok(audit.n >= 1, 'o descarte é auditado');
  assert.equal(await purge(), 0, 'segunda passagem não acha mais nada');
  legacy.dispose();
});

test('m9d900 o prazo do descarte é parâmetro lido de verdade', { skip: skip() }, async () => {
  const legacy = await loaded();
  await env.adminQuery("UPDATE governance.mig_records SET state = 'RECONCILED', updated_at = now() - interval '2 days' WHERE source_system = $1", [legacy.system]);
  await purge();
  assert.ok((await payloads(legacy.system)).every(([, , has]) => has), 'prazo de 30 dias: nada sai');
  await setSetting(DAYS, 1);
  await purge();
  assert.ok((await payloads(legacy.system)).every(([, , has]) => !has), 'prazo de 1 dia: sai tudo');
  legacy.dispose();
});

test('m9d900 replay depois do descarte dá o mesmo root_hash e devolve o conteúdo', { skip: skip() }, async () => {
  const legacy = await loaded();
  const [original] = await env.batchesOf(legacy.system);
  await env.adminQuery("UPDATE governance.mig_records SET state = 'RECONCILED', updated_at = now() - interval '40 days' WHERE source_system = $1", [legacy.system]);
  await purge();
  assert.ok((await payloads(legacy.system)).every(([, , has]) => !has));
  const replay = await replayBatch(A(), { userId: A().userId }, original.id);
  assert.equal(replay.batch.root_hash, original.root_hash, 'mesma raiz');
  assert.equal(replay.batch.replay_of, original.id);
  assert.ok((await payloads(legacy.system)).every(([, , has]) => has), 'o replay releu a origem e devolveu o conteúdo');
  legacy.dispose();
});
