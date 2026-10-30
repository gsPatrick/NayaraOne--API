'use strict';

// M9-D871 — expiração das flags temporárias: estado EXPIRED, perda de efeito, notificação CRITICAL ao responsável uma vez por flag e dia, isolamento e horário do job (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d871.expiracao.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d871Env');
const { isDue } = require('../../../src/engines/jobs/featureFlagExpiryJob');
const { runFeatureFlagExpiryJob } = require('../../../src/engines/jobs/featureFlagExpiryJob');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { readFlagsParams } = require('../../../src/features/core-governance/feature-flags/flags.params');
const { FLAGS_SETTINGS_SCHEMA, KEYS } = require('../../../src/features/core-governance/feature-flags/flags.settings');
const { GOVERNANCE_SETTINGS_SCHEMA } = require('../../../src/features/core-governance/governance.settings');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);

test('m9d871 flag vencida alerta', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkExpiredFlag(A, tx, { risk: 'HIGH' });
  const result = await env.expiry.runExpiry(A, tx, { now: env.NOW });
  assert.deepEqual(result.expired.map((e) => e.key), [flag.key]);
  const row = (await env.repo.findAnywhere(A, flag.id, tx));
  assert.deepEqual([row.state, row.version], ['EXPIRED', 2], 'passa a EXPIRED e sobe a versão');
  const notes = await env.notificationsOf(A.userId, tx, flag.key);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /CRÍTICO/);
  assert.match(notes[0].body, new RegExp(`${flag.key}.*2026-10-26`));
  const audit = await env.auditOf(flag.id, tx);
  assert.equal(audit.length, 2, 'criação e expiração auditadas');
  assert.equal(audit[1].afterJson.state, 'EXPIRED');
  assert.equal(audit[1].beforeJson.state, 'ACTIVE');
  const versions = await env.versionsOf(flag.id, tx);
  assert.deepEqual(versions.map((v) => [v.version, v.state]), [[1, 'ACTIVE']], 'a versão anterior fica guardada');
}));

test('m9d871 vencida perde o efeito (regra de validade de M9-D870)', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkExpiredFlag(A, tx, { value: true });
  const before = await env.resolve(A, flag.key, {}, tx, { defaultValue: 'padrao', now: new Date('2026-10-26T06:00:00Z') });
  assert.deepEqual([before.found, before.value], [true, true], 'antes do fim ainda vale');
  await env.expiry.runExpiry(A, tx, { now: env.NOW });
  const after = await env.resolve(A, flag.key, {}, tx, { defaultValue: 'padrao', now: env.NOW });
  assert.deepEqual([after.found, after.value, after.origin.scope], [false, 'padrao', 'DEFAULT']);
  const later = await env.resolve(A, flag.key, {}, tx, { defaultValue: 'padrao', now: new Date('2026-10-26T06:00:00Z') });
  assert.equal(later.found, false, 'a chave EXPIRED é ignorada mesmo para um instante anterior ao fim');
}));

test('m9d871 job duas vezes no dia não duplica notificação', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkExpiredFlag(A, tx);
  await env.expiry.runExpiry(A, tx, { now: env.NOW });
  const second = await env.expiry.runExpiry(A, tx, { now: new Date('2026-10-27T18:00:00Z') });
  assert.equal(second.expired.length, 0);
  assert.equal(second.reminded, 0, 'o lembrete do mesmo dia não repete');
  assert.equal((await env.notificationsOf(A.userId, tx, flag.key)).length, 1);
  const next = await env.expiry.runExpiry(A, tx, { now: new Date('2026-10-28T12:00:00Z') });
  assert.equal(next.reminded, 1, 'no dia seguinte a flag ainda vencida lembra o responsável');
  assert.equal((await env.notificationsOf(A.userId, tx, flag.key)).length, 2);
}));

test('m9d871 o lembrete diário é parâmetro e extender a validade encerra os avisos', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkExpiredFlag(A, tx);
  await env.expiry.runExpiry(A, tx, { now: env.NOW });
  await upsertSetting(KEYS.expiryReminder, false, A, A.userId, tx);
  const off = await env.expiry.runExpiry(A, tx, { now: new Date('2026-10-28T12:00:00Z') });
  assert.equal(off.reminded, 0, 'lembrete desligado pelo administrador');
  await upsertSetting(KEYS.expiryReminder, true, A, A.userId, tx);
  await env.patch(A, tx, { id: flag.id, validUntil: '2026-12-31T00:00:00Z', reason: 'Prorrogada.' }, env.NOW);
  const after = await env.expiry.runExpiry(A, tx, { now: new Date('2026-10-29T12:00:00Z') });
  assert.deepEqual([after.expired.length, after.reminded], [0, 0], 'reativada: nada a avisar');
}));

test('m9d871 sem fim vencido nada é expirado e permanente nunca expira', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const future = await env.mkFlag(A, tx, { temporary: true, validUntil: '2026-12-01T00:00:00Z' });
  const permanent = await env.mkFlag(A, tx, { temporary: false, validUntil: env.YESTERDAY });
  const result = await env.expiry.runExpiry(A, tx, { now: env.NOW });
  assert.equal(result.expired.length, 0);
  assert.equal((await env.repo.findAnywhere(A, future.id, tx)).state, 'ACTIVE');
  assert.equal((await env.repo.findAnywhere(A, permanent.id, tx)).state, 'ACTIVE');
}));

test('m9d871 responsável inativo: o aviso vai aos administradores', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkExpiredFlag(A, tx);
  await env.sequelize.query("UPDATE core.user_memberships SET status = 'INACTIVE' WHERE user_id = :u AND company_id = :c", { transaction: tx, replacements: { u: A.userId, c: A.companyId } });
  const result = await env.expiry.runExpiry(A, tx, { now: env.NOW });
  assert.equal(result.expired.length, 1, 'expira do mesmo jeito');
  assert.equal((await env.notificationsOf(A.userId, tx, flag.key)).length, 0, 'inativo não recebe');
}));

test('m9d871 isolamento entre empresas', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkExpiredFlag(A, tx);
  const other = await env.expiry.runExpiry(tenants.B, tx, { now: env.NOW });
  assert.equal(other.expired.length, 0, 'a outra empresa não enxerga nem expira a flag de A');
  assert.equal((await env.repo.findAnywhere(A, flag.id, tx)).state, 'ACTIVE');
  assert.equal((await env.notificationsOf(A.userId, tx, flag.key)).length, 0);
  assert.equal((await env.expiry.runExpiry(A, tx, { now: env.NOW })).expired.length, 1);
}));

test('m9d871 job das 06:30 de Brasília, uma vez por dia, com hora e minuto do administrador', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const params = await readFlagsParams(A, tx);
  assert.deepEqual([params.expiryHour, params.expiryMinute, params.expiryReminderDaily], [6, 30, true]);
  const t = { companyId: 'empresa-qa-871' };
  const at = (iso) => new Date(iso); // 09:30Z = 06:30 em Brasília
  assert.equal(isDue(t, params, at('2026-10-27T09:29:59Z'), false), false);
  assert.equal(isDue(t, params, at('2026-10-27T09:30:00Z'), false), true);
  assert.equal(isDue(t, { ...params, expiryHour: 8, expiryMinute: 0 }, at('2026-10-27T09:30:00Z'), false), false, 'o horário vem do parâmetro');
  assert.equal(isDue(t, { ...params, expiryHour: 8, expiryMinute: 0 }, at('2026-10-27T11:00:00Z'), false), true);
  assert.equal(isDue(t, params, at('2026-10-27T09:29:00Z'), true), true, 'force ignora o horário');
  await upsertSetting(KEYS.expiryHour, 7, A, A.userId, tx);
  assert.equal((await readFlagsParams(A, tx)).expiryHour, 7);
  assert.ok([KEYS.expiryHour, KEYS.expiryMinute, KEYS.expiryReminder].every((k) => k in FLAGS_SETTINGS_SCHEMA && k in GOVERNANCE_SETTINGS_SCHEMA), 'parâmetros no dicionário do administrador');
}));

test('m9d871 o job percorre as empresas e expira a flag vencida de verdade', { skip: skip() }, async () => {
  const result = await runFeatureFlagExpiryJob(env.NOW, { force: true });
  assert.equal(result.errors, 0);
  assert.ok(result.summaries.every((s) => Array.isArray(s.expired)));
});
