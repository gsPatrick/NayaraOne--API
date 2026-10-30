'use strict';

// M9-D911 — falha no meio do apply: o lote com erro é desfeito, a rodada vira FAILED e é retomada só nos lotes pendentes, sem repetir os concluídos.
// Banco descartável: ver m9d911.politica.test.js.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d911Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const A = () => tenants.A;
const NOW = new Date('2026-03-10T15:00:00Z');
before(async () => {
  if (!env.DISPOSABLE) return;
  tenants = await env.loadTenants(); await env.resetRetention(A()); await env.clearSignals(A());
  await env.inTx(A(), (tx) => upsertSetting('governanca.retencao.lote_tamanho', 10, A(), A().userId, tx));
});
afterEach(() => env.holdGuard.resetProvider());
after(async () => {
  if (env.DISPOSABLE) { await env.adminQuery("DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = 'governanca.retencao.lote_tamanho'", [A().companyId]); await env.clearSignals(A()); await env.resetRetention(A()); }
  await env.sequelize.close();
});

test('m9d911 run falho é retomado sem repetir lotes: o lote 2 falha, o 1 fica concluído, o 3 não começa; a retomada faz só o 2 e o 3', { skip: env.skip() }, async () => {
  await env.clearSignals(A());
  await env.insertSignals(A(), 25, '2023-01-15T12:00:00Z');
  const dry = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  let calls = 0;
  env.holdGuard.setProvider({ isOnHold: async () => false, heldIds: async () => { calls += 1; if (calls === 2) throw new Error('falha simulada no segundo lote'); return []; } });
  await assert.rejects(env.apply(A(), dry.id, { now: NOW }), (err) => err.statusCode === 500 && err.code === 'GOV_RETENTION_APPLY_FAILED' && !JSON.stringify(err.details || {}).includes('simulada'));
  const failed = (await env.adminQuery('SELECT status, error_message FROM governance.retention_runs WHERE id = $1', [dry.id])).rows[0];
  assert.deepEqual([failed.status, failed.error_message], ['FAILED', 'falha simulada no segundo lote']);
  assert.equal(await env.countSignals(A()), 15, 'só o primeiro lote (10) foi concluído; o lote com erro foi desfeito por inteiro');
  assert.deepEqual((await env.items(dry.id, "state = 'DONE'")).map((i) => i.batch_no), Array(10).fill(0));
  assert.equal((await env.items(dry.id, "state = 'PENDING'")).length, 15);

  env.holdGuard.resetProvider();
  const resumed = await env.apply(A(), dry.id, { now: NOW });
  assert.equal(resumed.status, 'APPLIED');
  assert.equal(resumed.applySummary.resumed, true);
  assert.equal(await env.countSignals(A()), 0);
  const batches = await env.audits(A(), 'governance.retention.batch', dry.id);
  assert.deepEqual(batches.map((b) => [b.after_json.batchNo, b.after_json.done]), [[0, 10], [1, 10], [2, 5]], 'o lote 0 aparece uma vez: não foi repetido');
  assert.deepEqual((await env.audits(A(), 'governance.retention.apply.started', dry.id)).map((a) => a.after_json.resumed), [false, true]);
});

test('m9d911 rodada abandonada em APPLYING (sem sinal de vida) é retomada; a que está viva recusa com RUN_IN_PROGRESS', { skip: env.skip() }, async () => {
  await env.clearSignals(A());
  await env.insertSignals(A(), 12, '2023-01-15T12:00:00Z');
  const dry = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  await env.adminQuery("UPDATE governance.retention_runs SET status = 'APPLYING', mode = 'APPLY', updated_at = now() WHERE id = $1", [dry.id]);
  await assert.rejects(env.apply(A(), dry.id, { now: new Date() }), (err) => err.statusCode === 409 && err.code === 'GOV_RETENTION_RUN_IN_PROGRESS');
  assert.equal(await env.countSignals(A()), 12);
  await env.adminQuery("UPDATE governance.retention_runs SET updated_at = now() - interval '2 hours' WHERE id = $1", [dry.id]);
  const resumed = await env.apply(A(), dry.id, { now: new Date() });
  assert.equal(resumed.status, 'APPLIED');
  assert.equal(await env.countSignals(A()), 0);
});
