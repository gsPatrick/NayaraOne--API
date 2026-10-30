'use strict';

// M9-D870 — configurações existentes entram no registro sem perder valor; os cinco interruptores de degradação da M9-D863 são flags lidas por flags.resolve (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d870.migracao.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d870Env');
const { upsertSetting, getSetting } = require('../../../src/features/settings/settings.service');
const { isStepActive } = require('../../../src/features/core-governance/finops/degradation/state');
const { switchKey } = require('../../../src/features/core-governance/feature-flags/flags.degradation');
const { STEPS } = require('../../../src/features/core-governance/finops/degradation/degradation.constants');
const finops = require('../_helpers/m9d863Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const find = async (A, key, tx) => (await env.service.listEntries(A, { key }, A.userId, tx)).itens.find((i) => i.key === key);

test('m9d870 configurações existentes migram sem perder valor', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  await upsertSetting('governanca.finops.janela_dias', 45, A, A.userId, tx);
  await upsertSetting('governanca.finops.moeda', 'BRL', A, A.userId, tx);
  await upsertSetting('governanca.modulos.dlp.habilitado', false, A, A.userId, tx);
  const all = (await env.service.listEntries(A, { kind: 'CONFIG' }, A.userId, tx)).itens;
  const days = all.find((i) => i.key === 'governanca.finops.janela_dias');
  assert.deepEqual([days.value, days.kind, days.valueType, days.scope, days.scopeRef, days.ownerUserId, days.version, days.risk, days.source], [45, 'CONFIG', 'INTEGER', 'COMPANY', A.companyId, A.userId, 1, 'LOW', 'TENANT_SETTING']);
  assert.deepEqual([all.find((i) => i.key === 'governanca.modulos.dlp.habilitado').value, all.find((i) => i.key === 'governanca.modulos.dlp.habilitado').valueType], [false, 'BOOLEAN']);
  assert.equal(all.find((i) => i.key === 'governanca.finops.moeda').valueType, 'ENUM', 'lista fechada do dicionário vira ENUM com os valores permitidos');
  assert.deepEqual(all.find((i) => i.key === 'governanca.finops.moeda').allowedValues, ['BRL']);
  // o serviço de leitura existente continua devolvendo o mesmo valor
  assert.equal(await getSetting('governanca.finops.janela_dias', A, tx, 30), 45);
  // idempotente: listar de novo não duplica nem mexe na versão
  const again = await find(A, 'governanca.finops.janela_dias', tx);
  assert.deepEqual([again.id, again.version], [days.id, 1]);
  assert.equal(all.filter((i) => i.key === 'governanca.finops.janela_dias').length, 1);
  // o valor vivo acompanha a tela de Parâmetros: mudou lá, o registro mostra e o flags.resolve devolve
  await upsertSetting('governanca.finops.janela_dias', 60, A, A.userId, tx);
  assert.equal((await find(A, 'governanca.finops.janela_dias', tx)).value, 60);
  const r = await env.resolve(A, 'governanca.finops.janela_dias', {}, tx, { defaultValue: 30 });
  assert.deepEqual([r.value, r.origin.scope, r.found], [60, 'COMPANY', true]);
}));

test('m9d870 alterar configuração absorvida grava no serviço existente, sobe versão e audita', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  await upsertSetting('governanca.finops.janela_dias', 45, A, A.userId, tx);
  const cfg = await find(A, 'governanca.finops.janela_dias', tx);
  const next = await env.patch(A, tx, { id: cfg.id, value: 90, reason: 'Mais histórico.' });
  assert.deepEqual([next.version, next.value], [2, 90]);
  assert.equal(await getSetting('governanca.finops.janela_dias', A, tx, 30), 90, 'getSetting enxerga o valor novo');
  assert.deepEqual((await env.versionsOf(cfg.id, tx)).map((v) => [v.version, v.value]), [[1, 45]]);
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: cfg.id, value: 'muitos', reason: 'x' })), [422, 'GOV_FLAG_VALUE_INVALID']);
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: cfg.id, value: 9999, reason: 'x' })), [400, 'SETTING_INVALID_VALUE'], 'o dicionário de configurações continua mandando nos limites');
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: cfg.id, validUntil: env.isoIn(86400000), reason: 'x' })), [422, 'GOV_FLAG_SOURCE_LOCKED']);
  assert.equal((await env.auditOf(cfg.id, tx)).length, 1);
}));

test('m9d870 configuração cifrada nunca entra no registro', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
  const secretKey = Object.keys(SETTINGS_SCHEMA).find((k) => SETTINGS_SCHEMA[k].encrypted);
  if (!secretKey) return;
  await upsertSetting(secretKey, 'segredo-de-teste', A, A.userId, tx);
  const items = (await env.service.listEntries(A, {}, A.userId, tx)).itens;
  assert.ok(!items.some((i) => i.key === secretKey), 'o segredo não vira linha do registro');
}));

test('m9d870 os cinco interruptores da degradação por custo são flags com responsável, escopo e risco, lidas por flags.resolve', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const budget = await finops.mkBudget(A, tx);
  await finops.putPolicy(A, tx, finops.fullPolicy(budget.id));
  await finops.spend(A, tx, 450000);
  for (let i = 0; i < 6; i += 1) await finops.degrade(A, tx);
  for (const step of STEPS) {
    const entry = await find(A, switchKey(step), tx);
    assert.ok(entry, `${step} registrado`);
    assert.deepEqual([entry.kind, entry.valueType, entry.value, entry.scope, entry.scopeRef, entry.ownerUserId, entry.risk, entry.version], ['FLAG', 'BOOLEAN', true, 'COMPANY', A.companyId, A.userId, 'MEDIUM', 1], step);
    const r = await env.resolve(A, switchKey(step), {}, tx);
    assert.deepEqual([r.value, r.origin.scope, r.origin.entryId], [true, 'COMPANY', entry.id]);
    assert.equal(await isStepActive(step, A, tx), true, `o ponto de leitura state.js lê ${step}`);
  }
  await finops.degrade(A, tx, finops.nextMonth());
  for (const step of STEPS) {
    const entry = await find(A, switchKey(step), tx);
    assert.deepEqual([entry.value, entry.version], [false, 2], `${step} desfeito no novo período: versão sobe e valor volta`);
    assert.equal(await isStepActive(step, A, tx), false);
    assert.equal((await env.auditOf(entry.id, tx)).length, 2, 'criação (já ligada, na aplicação) e reversão auditadas');
  }
}));

test('m9d870 o risco dos interruptores e o das configurações absorvidas vêm de parâmetro', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  await upsertSetting('governanca.flags.risco_interruptores_degradacao', 'HIGH', A, A.userId, tx);
  await upsertSetting('governanca.flags.risco_config_absorvida', 'MEDIUM', A, A.userId, tx);
  await upsertSetting('governanca.finops.janela_dias', 20, A, A.userId, tx);
  assert.equal((await find(A, 'governanca.finops.janela_dias', tx)).risk, 'MEDIUM');
  const budget = await finops.mkBudget(A, tx);
  await finops.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step: 'LIMIT_EXPORT_SIZE' }] });
  await finops.spend(A, tx, 450000);
  await finops.degrade(A, tx);
  assert.equal((await find(A, switchKey('LIMIT_EXPORT_SIZE'), tx)).risk, 'HIGH');
  await upsertSetting('governanca.flags.valor_max_caracteres', 100, A, A.userId, tx);
  assert.deepEqual(await env.codeOf(env.mkConfig(A, tx, { valueType: 'STRING', value: 'x'.repeat(101) })), [422, 'GOV_FLAG_VALUE_INVALID'], 'o tamanho máximo vem do parâmetro');
  assert.ok((await env.mkConfig(A, tx, { valueType: 'STRING', value: 'x'.repeat(100) })).id);
}));
