'use strict';

// M9-D824 — detecção de anomalia de acesso em massa (limiares, sinais, falha segura, isolamento). Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d824.deteccao.test.js"
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d824Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const review = require('../../../src/features/core-governance/dlp/anomaly.review');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => {
  if (!env.DISPOSABLE) return;
  tenants = await env.loadTenants();
  await env.clean();
  await env.setRolePermission('CI GESTOR', env.ADMIN, true);
});
afterEach(async () => { env.teardown(); if (env.DISPOSABLE) await env.clean(); });
after(async () => { if (env.DISPOSABLE) await env.setRolePermission('CI GESTOR', env.ADMIN, false); await env.sequelize.close(); });
const A = () => tenants.A;
const userA = () => tenants.A.userId;

test('m9d824 mass export dispara anomaly', { skip: skip() }, async () => {
  env.setup({ default: 'LOW' });
  await env.seedSignals(A(), userA(), [{ kind: 'EXPORT', count: 1, minutesAgo: 20 }]);
  assert.equal((await env.anomaliesOf(A())).length, 0, 'um pedido só não é anomalia');
  const second = await env.exportOf(A(), userA(), { mfaOk: false, resource: 'rest', estimatedRows: 10 });
  assert.equal(second.decision, 'ALLOW', 'LOW passa sem MFA');
  const third = await env.exportOf(A(), userA());
  assert.equal(third.decision, 'ALLOW', 'o terceiro pedido ainda é decidido antes da anomalia existir');
  const [anomaly] = await env.anomaliesOf(A());
  assert.deepEqual([anomaly.kind, anomaly.status, anomaly.user_id, anomaly.window_minutes], ['EXPORT', 'OPEN', userA(), 30]);
  assert.equal(anomaly.trigger_signals.total, 3);
  assert.equal(anomaly.trigger_signals.limit, 3);
  const state = await env.stateOf(A(), userA());
  assert.ok(new Date(state.dlp_restricted_until) > new Date(Date.now() + 23 * 3600 * 1000), 'EXPORT/SHARE/PRINT suspensos por 24 h');
  assert.ok(new Date(state.mfa_step_up_forced_until) > new Date(Date.now() + 23 * 3600 * 1000), 'MFA novo por 24 h');
  const audits = (await env.auditOf(A(), 'governance.dlp.anomaly.opened')).filter((row) => row.entity_id === anomaly.id);
  assert.equal(audits.length, 1);
  const notes = (await env.adminQuery("SELECT user_id, channel FROM core.notifications WHERE company_id = $1 AND title = 'Acesso em massa detectado'", [A().companyId])).rows;
  assert.ok(notes.length >= 1 && notes.every((n) => n.channel === 'IN_APP'), 'aviso IN_APP a quem tem governance:dlp:admin');
  assert.ok(notes.some((n) => n.user_id === userA()), 'o gestor com a permissão foi avisado');
  const blocked = await env.exportOf(A(), userA());
  assert.deepEqual([blocked.decision, blocked.blockReason, blocked.errorCode], ['DENY', 'SUSPENDED', 'GOV_DLP_USER_SUSPENDED']);
});

test('m9d824 pedidos bloqueados também contam e fora da janela de 30 minutos não contam', { skip: skip() }, async () => {
  env.setup({ default: 'HIGH' });
  await env.seedSignals(A(), userA(), [{ kind: 'EXPORT', minutesAgo: 45 }, { kind: 'EXPORT', minutesAgo: 40 }]);
  const blocked = await env.exportOf(A(), userA(), { mfaOk: false });
  assert.equal(blocked.decision, 'DENY');
  assert.equal((await env.anomaliesOf(A())).length, 0, 'dois fora da janela e um dentro: 1 < 3');
  await env.exportOf(A(), userA(), { mfaOk: false });
  await env.exportOf(A(), userA(), { mfaOk: false });
  const [anomaly] = await env.anomaliesOf(A());
  assert.equal(anomaly.trigger_signals.total, 3, 'três bloqueados dentro da janela');
  assert.equal(anomaly.trigger_signals.denied, 3);
});

test('m9d824 150 leituras não disparam', { skip: skip() }, async () => {
  env.setup({ default: 'HIGH' });
  await env.seedSignals(A(), userA(), [{ kind: 'READ', classification: 'HIGH', count: 100, minutesAgo: 8 }]);
  await env.touch(A(), userA(), 'VIEW', 50);
  assert.equal((await env.anomaliesOf(A())).length, 0, '150 HIGH em 10 minutos');
  await env.touch(A(), userA(), 'VIEW', 50);
  assert.equal((await env.anomaliesOf(A())).length, 0, 'exatamente 200 não passa de 200');
  await env.touch(A(), userA(), 'VIEW', 1);
  const [anomaly] = await env.anomaliesOf(A());
  assert.deepEqual([anomaly.kind, anomaly.trigger_signals.total, anomaly.trigger_signals.classification], ['READ', 201, 'HIGH']);
});

test('m9d824 250 leituras HIGH em 8 minutos abrem a anomalia e 20 RESTRICTED também', { skip: skip() }, async () => {
  env.setup({ rest: 'RESTRICTED', default: 'HIGH' });
  await env.seedSignals(A(), userA(), [{ kind: 'READ', classification: 'HIGH', count: 200, minutesAgo: 8 }]);
  await env.touch(A(), userA(), 'VIEW', 50);
  assert.equal((await env.anomaliesOf(A(), 'OPEN')).length, 1, '250 > 200');
  await env.clean();
  const restricted = (n) => env.touch(A(), userA(), 'VIEW', n, 'rest');
  await restricted(20);
  assert.equal((await env.anomaliesOf(A())).length, 0, '20 RESTRICTED não passa de 20');
  await restricted(1);
  const [anomaly] = await env.anomaliesOf(A());
  assert.deepEqual([anomaly.kind, anomaly.trigger_signals.classification, anomaly.trigger_signals.total], ['READ', 'RESTRICTED', 21]);
});

test('m9d824 cópia registrada conta como sinal', { skip: skip() }, async () => {
  env.setup({ default: 'HIGH' });
  await env.touch(A(), userA(), 'VIEW', 150);
  await env.touch(A(), userA(), 'COPY', 50);
  assert.equal((await env.anomaliesOf(A())).length, 0, '150 leituras + 50 cópias = 200');
  const signals = await env.signalsOf(A(), userA());
  assert.deepEqual(signals.map((s) => [s.kind, s.count]), [['READ', 150], ['COPY', 50]]);
  await env.touch(A(), userA(), 'COPY', 1);
  const [anomaly] = await env.anomaliesOf(A());
  assert.equal(anomaly.trigger_signals.total, 201, 'a cópia soma com a leitura da mesma classe');
});

test('m9d824 cópia negada de RESTRICTED vira sinal DENIED e LOW e MEDIUM não geram sinal', { skip: skip() }, async () => {
  env.setup({ rest: 'RESTRICTED', med: 'MEDIUM', low: 'LOW' });
  await env.touch(A(), userA(), 'COPY', 1, 'rest');
  await env.touch(A(), userA(), 'VIEW', 5, 'med');
  await env.touch(A(), userA(), 'VIEW', 5, 'low');
  const signals = await env.signalsOf(A(), userA());
  assert.deepEqual(signals.map((s) => [s.kind, s.classification, s.outcome, s.count]), [['COPY', 'RESTRICTED', 'DENIED', 1]]);
});

test('m9d824 segunda anomalia do mesmo usuário e tipo não abre enquanto houver OPEN', { skip: skip() }, async () => {
  env.setup({ default: 'LOW' });
  for (let i = 0; i < 5; i += 1) await env.exportOf(A(), userA(), { idempotencyKey: `k-${i}` }).catch(() => null);
  const open = await env.anomaliesOf(A(), 'OPEN');
  assert.equal(open.length, 1, 'cinco pedidos, uma anomalia aberta');
  await env.touch(A(), userA(), 'VIEW', 1);
  env.setup({ default: 'HIGH' });
  await env.touch(A(), userA(), 'VIEW', 201);
  assert.deepEqual((await env.anomaliesOf(A(), 'OPEN')).map((a) => a.kind).sort(), ['EXPORT', 'READ'], 'tipos diferentes convivem');
  await env.touch(A(), userA(), 'VIEW', 300);
  assert.equal((await env.anomaliesOf(A(), 'OPEN')).length, 2, 'a leitura aberta impede outra leitura');
  await assert.rejects(
    env.adminQuery(`INSERT INTO governance.access_anomalies (group_id, company_id, user_id, kind, status, window_minutes, trigger_signals) VALUES ($1,$2,$3,'READ','OPEN',10,'{}')`, [A().groupId, A().companyId, userA()]),
    /gov_accano_open_uq/, 'o índice único parcial também barra no banco'
  );
});

test('m9d824 os limiares e as horas são lidos dos parâmetros', { skip: skip() }, async () => {
  env.setup({ default: 'LOW' });
  await env.withTenantTransaction(A(), async (tx) => {
    await upsertSetting('governanca.dlp.anomalia.limiares', 'HIGH 5/10; RESTRICTED 2/10; EXPORT 2/30', A(), userA(), tx);
    await upsertSetting('governanca.dlp.anomalia.suspensao_horas', 2, A(), userA(), tx);
    await upsertSetting('governanca.dlp.anomalia.mfa_horas', 3, A(), userA(), tx);
  });
  await env.exportOf(A(), userA());
  await env.exportOf(A(), userA());
  const [anomaly] = await env.anomaliesOf(A());
  assert.equal(anomaly.trigger_signals.limit, 2, 'exportação em massa a partir de 2');
  const state = await env.stateOf(A(), userA());
  const hours = (date) => (new Date(date).getTime() - Date.now()) / 3600000;
  assert.ok(hours(state.dlp_restricted_until) > 1.9 && hours(state.dlp_restricted_until) <= 2.01, 'suspensão de 2 h');
  assert.ok(hours(state.mfa_step_up_forced_until) > 2.9 && hours(state.mfa_step_up_forced_until) <= 3.01, 'MFA novo por 3 h');
});

test('m9d824 falha do detector em RESTRICTED mantém bloqueio', { skip: skip() }, async () => {
  env.setup({ rest: 'RESTRICTED', alto: 'HIGH' });
  await env.adminQuery('ALTER TABLE governance.access_signals RENAME TO access_signals_off');
  try {
    const high = await env.touch(A(), userA(), 'VIEW', 1, 'alto');
    assert.equal(high.decision, 'ALLOW', 'HIGH segue liberado (com alerta no log) quando o detector falha');
    await assert.rejects(env.touch(A(), userA(), 'VIEW', 1, 'rest'), 'RESTRICTED: a decisão não conclui, a ação segue bloqueada');
    await assert.rejects(env.exportOf(A(), userA(), { resource: 'rest', estimatedRows: 10 }), 'exportação de RESTRICTED também não é liberada');
    const jobs = (await env.adminQuery("SELECT status FROM governance.export_jobs WHERE company_id = $1 AND resource_type = 'finance.entries'", [A().companyId])).rows;
    assert.deepEqual(jobs.map((j) => j.status), ['FAILED'], 'o pedido fica registrado como FAILED');
  } finally {
    await env.adminQuery('ALTER TABLE governance.access_signals_off RENAME TO access_signals');
  }
});

test('m9d824 isolamento entre empresas', { skip: skip() }, async () => {
  env.setup({ default: 'LOW' });
  const userB = tenants.B.userId;
  await env.seedSignals(A(), userA(), [{ kind: 'EXPORT', minutesAgo: 5 }, { kind: 'EXPORT', minutesAgo: 4 }]);
  await env.exportOf(tenants.B, userB);
  await env.exportOf(tenants.B, userB);
  assert.equal((await env.anomaliesOf(tenants.B)).length, 0, 'os sinais de A não somam para B');
  await env.exportOf(A(), userA());
  assert.equal((await env.anomaliesOf(A())).length, 1);
  assert.equal((await env.anomaliesOf(tenants.B)).length, 0);
  const listed = await env.withRollbackTenantTransaction(tenants.B, (tx) => review.listAnomalies(tenants.B, {}, tx));
  assert.equal(listed.total, 0, 'a RLS esconde a anomalia de A');
  assert.equal(await env.stateOf(tenants.B, userB), null);
});
