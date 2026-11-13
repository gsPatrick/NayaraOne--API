'use strict';

// Parâmetros sensíveis com MFA recente para alterar (Maturacao/demandas/parametros.csv, coluna exige_mfa_para_alterar = "sim"; DI-DEC007-1). A entrada do
// SETTINGS_SCHEMA leva `requiresMfa: true` e a camada de escrita (upsertSetting -> settingMfa.js) exige a verificação recente de quem altera, pelo mesmo
// mecanismo do resto da API (assertRecentMfa: 403 MFA_STEP_UP_REQUIRED / MFA_REQUIRED_NOT_ENABLED). Para cada chave marcada: sem pessoa, sem MFA e com MFA
// vencido => recusa e nada gravado; com MFA recente REAL (TOTP pela camada de serviço, test/helpers/mfaRecente.js) => grava. Também pelo registro de flags
// (outro caminho de escrita) e pela rota PUT /settings/:key (HTTP real, com a recusa auditada). Banco descartável: o arquivo HTTP commita numa empresa isolada.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.SETTINGS_MFA_TEST_PORT || '62090';
require('../app');
const T = require('./testHelpers');
const { tokenFor, client, isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const { semMfa, comMfaRecente, mfaVencido } = require('./helpers/mfaRecente');
const settingsService = require('../src/features/settings/settings.service');
const flagsService = require('../src/features/core-governance/feature-flags/feature-flags.service');
const { TenantSetting, User } = require('../src/models');

// Lista fechada (vale também no CI, sem a pasta Maturacao): as 20 chaves do catálogo com MFA que existem no dicionário + a equivalente
// finance.reconciliation.auto_strong (= conciliacao.auto_confirmacao_ativa do catálogo). O teste meta (settings.mfaCatalogo.meta) confere contra o CSV.
const EXPECTED = [
  'billing.grace_period_days', 'billing.interest_percentage', 'billing.late_fee_percentage',
  'exportacao.crm.exige_mfa',
  'finance.antifraud_new_account_threshold', 'finance.bank_account_cooldown_hours', 'finance.reconciliation.auto_strong',
  'governanca.flags.kill_teste_dias', 'ia.fallback.max_saltos',
  'integration.admin.mfa_on_prod_connection_change', 'integration.admin.mfa_on_prod_test_connection', 'integration.admin.mfa_on_secret_rotation',
  'integration.registry.domain_resolution', 'integration.registry.secret_scan_min_length',
  'integration.secret.cache_ttl_s', 'integration.secret.expiry_alert_days', 'integration.secret.grace_period_min', 'integration.secret.mfa_on_bank_secret_change',
  'integration.secret.rotation_max_age_days.BANK',
  'mfa.required_for_sensitive_roles', 'mfa.step_up_ttl_minutes',
];
const SAMPLE_OVERRIDES = { 'integration.secret.expiry_alert_days': '30,14,7' };
function sample(key) {
  if (SAMPLE_OVERRIDES[key] !== undefined) return SAMPLE_OVERRIDES[key];
  const spec = settingsService.SETTINGS_SCHEMA[key];
  if (spec.type === 'boolean') return true;
  if (Array.isArray(spec.enum)) return spec.enum[spec.enum.length - 1];
  if (spec.type === 'integer' || spec.type === 'number') return spec.min !== undefined ? spec.min + 1 : 1;
  throw new Error(`sem valor de exemplo para ${key}`);
}

let tenant;
let http;
const ids = {};

before(async () => {
  tenant = await isolatedTenant('mfa-parametros');
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  for (const name of ['semMfa', 'vencido', 'recente', 'http']) {
    ids[name] = (await User.create({ email: `mfa-param-${name}-${T.uniqueSuffix()}@nayaraone.dev`, name: `MFA parâmetro ${name}`, passwordHash: 'x', status: 'ACTIVE' })).id;
  }
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
  process.exit(0);
});

const rollback = (fn) => T.withRollbackTenantTransaction(tenant, fn);
const stored = (key, t) => TenantSetting.count({ where: { companyId: tenant.companyId, key }, transaction: t });
const write = (key, actor, t) => settingsService.upsertSetting(key, sample(key), tenant, actor, t);
const rejectsWith = (promise, code) => assert.rejects(promise, (err) => { assert.equal(err.statusCode, 403); assert.equal(err.code, code, `${err.code} ${err.message}`); return true; });

test('mfa_parametros_lista_marcada: exatamente as chaves do catálogo com exige_mfa_para_alterar = sim (e a equivalente) levam requiresMfa no dicionário', () => {
  const marked = Object.entries(settingsService.SETTINGS_SCHEMA).filter(([, spec]) => spec.requiresMfa === true).map(([key]) => key).sort();
  assert.deepEqual(marked, [...EXPECTED].sort());
});

test('mfa_parametros_cada_chave: sem pessoa, sem MFA ou com MFA vencido a gravação é recusada e nada é gravado; com MFA recente (TOTP real) grava', async () => {
  for (const key of EXPECTED) {
    await rollback(async (t) => {
      await semMfa(ids.semMfa, t);
      await rejectsWith(write(key, null, t), 'MFA_STEP_UP_REQUIRED');
      await rejectsWith(write(key, ids.semMfa, t), 'MFA_REQUIRED_NOT_ENABLED');
      await comMfaRecente(ids.vencido, tenant, t);
      await mfaVencido(ids.vencido, t);
      await rejectsWith(write(key, ids.vencido, t), 'MFA_STEP_UP_REQUIRED');
      assert.equal(await stored(key, t), 0, `${key}: nada gravado sem MFA recente`);
      await comMfaRecente(ids.recente, tenant, t);
      await write(key, ids.recente, t);
      assert.deepEqual(await settingsService.getSetting(key, tenant, t), sample(key), `${key}: gravado com MFA recente`);
    });
  }
});

test('mfa_parametros_valor_invalido_nao_vaza_antes_do_mfa: sem MFA recente a recusa é de MFA, antes de olhar o valor; chave comum continua sem MFA', async () => {
  await rollback(async (t) => {
    await semMfa(ids.semMfa, t);
    await rejectsWith(settingsService.upsertSetting('finance.bank_account_cooldown_hours', -5, tenant, ids.semMfa, t), 'MFA_REQUIRED_NOT_ENABLED');
    await settingsService.upsertSetting('antifraude.duplicidade_janela_dias', 60, tenant, ids.semMfa, t); // não marcada no catálogo
    assert.equal(await settingsService.getSetting('antifraude.duplicidade_janela_dias', tenant, t), 60);
  });
});

test('mfa_parametros_registro_de_flags: o PATCH do registro (gravação nos parâmetros) também exige MFA recente de quem altera', async () => {
  await rollback(async (t) => {
    const key = 'finance.bank_account_cooldown_hours';
    await TenantSetting.create({ groupId: tenant.groupId, companyId: tenant.companyId, key, value: 48 }, { transaction: t });
    const listed = await flagsService.listEntries(tenant, {}, tenant.userId, t);
    const row = listed.itens.find((r) => r.key === key);
    assert.ok(row, 'a configuração foi absorvida pelo registro');
    await semMfa(ids.semMfa, t);
    const body = { id: row.id, reason: 'Ajuste do resfriamento pedido pela diretoria financeira.', value: 72 };
    await rejectsWith(flagsService.updateEntry(tenant, body, ids.semMfa, t, { permissions: [] }), 'MFA_REQUIRED_NOT_ENABLED');
    assert.equal(await settingsService.getSetting(key, tenant, t), 48);
    await comMfaRecente(ids.recente, tenant, t);
    await flagsService.updateEntry(tenant, body, ids.recente, t, { permissions: [] });
    assert.equal(await settingsService.getSetting(key, tenant, t), 72);
  });
});

test('mfa_parametros_rota_put: PUT /settings/:key sem MFA recente responde 403 MFA_STEP_UP_REQUIRED, não grava e audita a recusa; com MFA recente grava', async () => {
  const token = tokenFor(tenant, ids.http, ['settings:read', 'settings:update', 'roles:update']);
  const key = 'finance.bank_account_cooldown_hours';
  await T.withTenantTransaction(tenant, async (t) => { await comMfaRecente(ids.http, tenant, t); await mfaVencido(ids.http, t); });
  const denied = await http('PUT', `/settings/${encodeURIComponent(key)}`, token, { value: 96 });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.code, 'MFA_STEP_UP_REQUIRED');
  assert.equal(await T.withTenantTransaction(tenant, (t) => stored(key, t)), 0);
  const [audit] = await T.withTenantTransaction(tenant, (t) => T.sequelize.query(
    "SELECT after_json FROM audit.audit_log WHERE company_id = :c AND action = 'governance.setting.write_denied' ORDER BY created_at DESC LIMIT 1",
    { replacements: { c: tenant.companyId }, type: T.sequelize.QueryTypes.SELECT, transaction: t }
  ));
  assert.equal(audit && audit.after_json.key, key);
  assert.equal(audit.after_json.code, 'MFA_STEP_UP_REQUIRED');
  await T.withTenantTransaction(tenant, (t) => comMfaRecente(ids.http, tenant, t));
  const ok = await http('PUT', `/settings/${encodeURIComponent(key)}`, token, { value: 96 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const ttl = await http('PUT', `/settings/${encodeURIComponent('mfa.step_up_ttl_minutes')}`, token, { value: 15 });
  assert.equal(ttl.status, 200, JSON.stringify(ttl.body));
  assert.equal((await http('GET', `/settings/${encodeURIComponent(key)}`, token)).body.data.value, 96);
});
