'use strict';

// M9-D911 — o apply: reproduz exatamente o conjunto da simulação, só parte de uma simulação válida, uma vez, e reconfere hold, exceção, política e elegibilidade no lote.
// Banco descartável: ver m9d911.politica.test.js.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d911Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const A = () => tenants.A;
const NOW = new Date('2026-03-10T15:00:00Z');
const setBatch = (n) => env.inTx(A(), (tx) => upsertSetting('governanca.retencao.lote_tamanho', n, A(), A().userId, tx));
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.resetRetention(A()); await env.clearSignals(A()); await setBatch(10); } });
afterEach(() => env.holdGuard.resetProvider());
after(async () => { if (env.DISPOSABLE) { await env.adminQuery("DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = 'governanca.retencao.lote_tamanho'", [A().companyId]); await env.clearSignals(A()); await env.resetRetention(A()); } await env.sequelize.close(); });
const code = (promise) => promise.then(() => null, (err) => [err.statusCode, err.code]);
const OLD = '2023-01-15T12:00:00Z';
const fresh = async (old = 25, recent = 5) => { await env.clearSignals(A()); await env.insertSignals(A(), old, OLD); await env.insertSignals(A(), recent, '2026-02-01T12:00:00Z'); };

test('m9d911 apply reproduz exatamente o conjunto do dry-run (em lotes de 10, com auditoria por lote) e não toca no que apareceu depois', { skip: env.skip() }, async () => {
  await fresh();
  const dry = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  const planned = (await env.items(dry.id)).map((item) => item.record_id).sort();
  assert.equal(planned.length, 25);
  await env.insertSignals(A(), 1, OLD); // velho, mas posterior à simulação: não está no conjunto
  const applied = await env.apply(A(), dry.id, { now: NOW });
  assert.equal(applied.status, 'APPLIED');
  const remaining = await env.signalIds(A());
  assert.equal(planned.some((id) => remaining.includes(id)), false, 'todo o conjunto da simulação foi apagado');
  assert.equal(remaining.length, 5 + 1, 'o recente e o criado depois da simulação ficam');
  const done = await env.items(dry.id, "state = 'DONE'");
  assert.deepEqual(done.map((item) => item.record_id).sort(), planned, 'exatamente o conjunto');
  assert.deepEqual([...new Set(done.map((item) => item.batch_no))].sort(), [0, 1, 2], '25 itens em lotes de 10');
  const batches = await env.audits(A(), 'governance.retention.batch', dry.id);
  assert.equal(batches.length, 3, 'uma auditoria por lote');
  assert.deepEqual(batches.map((b) => b.after_json.done), [10, 10, 5]);
  assert.equal((await env.audits(A(), 'governance.retention.apply.finished', dry.id)).length, 1);
  assert.equal(applied.appliedBy, A().userId);
});

test('m9d911 apply exige dry-run prévio: rodada inexistente, de outra empresa ou vencida é 409 GOV_RETENTION_DRY_RUN_REQUIRED; aplicada de novo é 409 ALREADY_APPLIED', { skip: env.skip() }, async () => {
  await fresh(12, 0);
  assert.deepEqual(await code(env.apply(A(), '00000000-0000-4000-8000-000000000000')), [409, 'GOV_RETENTION_DRY_RUN_REQUIRED']);
  const dry = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  assert.deepEqual(await code(env.apply(tenants.B, dry.id)), [409, 'GOV_RETENTION_DRY_RUN_REQUIRED']);
  await env.adminQuery("UPDATE governance.retention_runs SET created_at = now() - interval '100 hours' WHERE id = $1", [dry.id]);
  assert.deepEqual(await code(env.apply(A(), dry.id)), [409, 'GOV_RETENTION_DRY_RUN_REQUIRED'], 'simulação mais velha que a validade do parâmetro');
  assert.equal(await env.countSignals(A()), 12, 'nada foi apagado');
  await env.adminQuery("UPDATE governance.retention_runs SET created_at = now() WHERE id = $1", [dry.id]);
  await env.apply(A(), dry.id, { now: NOW });
  assert.deepEqual(await code(env.apply(A(), dry.id)), [409, 'GOV_RETENTION_ALREADY_APPLIED']);
  assert.equal(await env.countSignals(A()), 0);
});

test('m9d911 apply reconfere no lote: hold que apareceu, política editada e registro que deixou de ser elegível são pulados com o motivo', { skip: env.skip() }, async () => {
  await fresh(20, 0);
  const dry = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  const ids = (await env.items(dry.id)).map((item) => item.record_id);
  env.setHold(new Set(ids.slice(0, 3)));
  const applied = await env.apply(A(), dry.id, { now: NOW });
  assert.equal(applied.status, 'APPLIED');
  const states = Object.fromEntries((await env.adminQuery('SELECT state, count(*)::int AS n FROM governance.retention_run_items WHERE run_id = $1 GROUP BY 1', [dry.id])).rows.map((r) => [r.state, r.n]));
  assert.deepEqual(states, { DONE: 17, SKIPPED_HOLD: 3 });
  assert.equal(await env.countSignals(A()), 3, 'os três sob hold sobreviveram');

  // Política editada depois da simulação: nada daquela simulação é aplicado.
  await fresh(8, 0);
  const second = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  await env.editPolicy(A(), 'LOGS_TECNICOS', { retention_months: 19 });
  try {
    await env.apply(A(), second.id, { now: NOW });
    assert.equal(await env.countSignals(A()), 8);
    assert.equal((await env.items(second.id, "state = 'SKIPPED_POLICY_CHANGED'")).length, 8);
  } finally { await env.editPolicy(A(), 'LOGS_TECNICOS', { retention_months: 18 }); }

  // Registro que deixou de ser elegível (data do gatilho passou a ser recente).
  await fresh(6, 0);
  const third = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  const touched = (await env.items(third.id))[0].record_id;
  await env.adminQuery("UPDATE governance.access_signals SET occurred_at = '2026-03-01' WHERE id = $1", [touched]);
  await env.apply(A(), third.id, { now: NOW });
  assert.equal((await env.items(third.id, "state = 'SKIPPED_NOT_ELIGIBLE'")).length, 1);
  assert.equal(await env.countSignals(A()), 1);
});

test('m9d911 duas aplicações ao mesmo tempo: só uma executa (a outra recebe RUN_IN_PROGRESS ou ALREADY_APPLIED) e o descarte acontece uma vez', { skip: env.skip() }, async () => {
  await fresh(30, 0);
  const dry = await env.dryRun(A(), { policyCodes: ['LOGS_TECNICOS'], now: NOW });
  const results = await Promise.allSettled([env.apply(A(), dry.id, { now: NOW }), env.apply(A(), dry.id, { now: NOW })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.ok(['GOV_RETENTION_RUN_IN_PROGRESS', 'GOV_RETENTION_ALREADY_APPLIED'].includes(rejected.reason.code), rejected.reason.code);
  assert.equal(await env.countSignals(A()), 0);
  assert.equal((await env.audits(A(), 'governance.retention.apply.started', dry.id)).length, 1, 'só uma aplicação começou');
});
