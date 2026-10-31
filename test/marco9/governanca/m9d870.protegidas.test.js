'use strict';

// M9-D870 (reabertura N1 da reauditoria rodada 2): as flags do canary de setor da migração (migracao.setor.<setor>.novo_sistema) só mudam pelo caminho do canary (gate, blockers,
// RACI, MFA). POST e PATCH /feature-flags com só governance:flags:manage as recusam com 403 GOV_FLAG_KEY_PROTECTED, sem gravar nada. Banco descartável. Nunca chama endpoint de MFA.

process.env.PORT = process.env.M9D870_PROTEGIDAS_TEST_PORT || '21871';
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d870Http');
const canaryFlag = require('../../../src/features/migration-v2/canary/canary.flag');
const flagsService = require('../../../src/features/core-governance/feature-flags/feature-flags.service');
const { openTenantTx } = require('../../../src/features/core-governance/data-quality/retention.tenantTx');

const KEY = 'migracao.setor.atendimento.novo_sistema';
const clean = async (companyId) => {
  await http.adminQuery('DELETE FROM governance.flag_versions WHERE company_id = $1 AND key LIKE $2', [companyId, 'migracao.setor.%']);
  await http.adminQuery('DELETE FROM governance.config_entries WHERE company_id = $1 AND key LIKE $2', [companyId, 'migracao.setor.%']);
  await http.adminQuery('DELETE FROM governance.feature_flags WHERE company_id = $1 AND key LIKE $2', [companyId, 'migracao.setor.%']);
};
const rowsOf = async (companyId) => (await http.adminQuery("SELECT id, value, version FROM governance.config_entries WHERE company_id = $1 AND key = $2", [companyId, KEY])).rows;
const tenantA = () => ({ ...http.state.tenants.A });
const codeOf = (promise) => promise.then(() => null, (err) => err.code);

before(async () => { await http.start(); });
afterEach(async () => { if (!http.state.skip) await clean(http.state.tenants.A.companyId); });
after(async () => { await http.stop(); });
const skipReason = () => http.state.skip;

const body = (A, extra = {}) => ({ key: KEY, kind: 'CONFIG', valueType: 'INTEGER', value: 100, ownerUserId: A.userId, scope: 'SECTOR', scopeRef: 'ATENDIMENTO', risk: 'CRITICAL', ...extra });

test('m9d870 N1: POST /feature-flags da flag do setor é 403 e não grava nada', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const res = await http.call('A:gestor', 'POST', '/feature-flags', body(A));
  assert.deepEqual([res.status, res.body.error.code], [403, 'GOV_FLAG_KEY_PROTECTED']);
  assert.match(res.body.error.message, /canary/i);
  assert.equal((await rowsOf(A.companyId)).length, 0, 'a flag em 100% não foi criada');
  const otherScope = await http.call('A:gestor', 'POST', '/feature-flags', body(A, { scope: 'COMPANY', scopeRef: A.companyId, kind: 'FLAG', valueType: 'BOOLEAN', value: true }));
  assert.deepEqual([otherScope.status, otherScope.body.error.code], [403, 'GOV_FLAG_KEY_PROTECTED'], 'a proteção é da chave, em qualquer escopo ou tipo');
});

test('m9d870 N1: PATCH /feature-flags da flag do setor, por id ou por chave, é 403 e o percentual não muda', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const entry = await openTenantTx(tenantA(), (tx) => canaryFlag.ensureEntry(tenantA(), 'ATENDIMENTO', A.userId, tx));
  await openTenantTx(tenantA(), (tx) => canaryFlag.writePercent(tenantA(), entry, 5, 'QA-M9 avanço legítimo do canary.', A.userId, tx));
  const before = (await rowsOf(A.companyId))[0];
  assert.deepEqual([Number(before.value), before.version], [5, 2]);
  for (const patch of [{ id: before.id, value: 100 }, { key: KEY, value: 100 }, { id: before.id, value: 0 }]) {
    const res = await http.call('A:gestor', 'PATCH', '/feature-flags', { ...patch, version: 2, reason: 'QA-M9 tentativa direta.' });
    assert.deepEqual([res.status, res.body.error.code], [403, 'GOV_FLAG_KEY_PROTECTED'], JSON.stringify(patch));
  }
  const after = (await rowsOf(A.companyId))[0];
  assert.deepEqual([Number(after.value), after.version], [5, 2], 'nem valor nem versão mudaram');
});

test('m9d870 N1: o próprio canary continua escrevendo a flag pelo serviço, e outro dono de chaves não a escreve', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const entry = await openTenantTx(tenantA(), (tx) => canaryFlag.ensureEntry(tenantA(), 'ATENDIMENTO', A.userId, tx));
  const updated = await openTenantTx(tenantA(), (tx) => canaryFlag.writePercent(tenantA(), entry, 25, 'QA-M9 avanço.', A.userId, tx));
  assert.equal(Number(updated.value), 25);
  const direct = { id: entry.id, value: 100, reason: 'QA-M9 sem dono.' };
  assert.equal(await codeOf(openTenantTx(tenantA(), (tx) => flagsService.updateEntry(tenantA(), direct, A.userId, tx))), 'GOV_FLAG_KEY_PROTECTED', 'serviço sem o dono da chave recusa');
  assert.equal(await codeOf(openTenantTx(tenantA(), (tx) => flagsService.updateEntry(tenantA(), direct, A.userId, tx, { owner: 'marketing.killswitch' }))), 'GOV_FLAG_KEY_PROTECTED', 'dono de outro conjunto de chaves também recusa');
  assert.equal(Number((await rowsOf(A.companyId))[0].value), 25);
});

test('m9d870 N1: chave comum continua criável e alterável pela API', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const key = `qa.m9d870.comum_${Date.now().toString(36)}`;
  const created = await http.call('A:gestor', 'POST', '/feature-flags', { key, value: true, ownerUserId: A.userId });
  assert.equal(created.status, 201);
  const patched = await http.call('A:gestor', 'PATCH', '/feature-flags', { id: created.body.data.id, value: false, reason: 'QA-M9 chave comum.' });
  assert.equal(patched.status, 200);
  await http.adminQuery("DELETE FROM governance.flag_versions WHERE key LIKE 'qa.m9d870.comum_%'");
  await http.adminQuery("DELETE FROM governance.feature_flags WHERE key LIKE 'qa.m9d870.comum_%'");
});
