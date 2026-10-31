'use strict';

// M9-D870 (reabertura R3-M1 da rodada 3): as chaves "só da plataforma" do dicionário de parâmetros não mudam por NENHUM caminho de escrita de quem tem só governance:flags:manage
// (ou só settings:update): PATCH /feature-flags com gravação nos parâmetros, PUT /settings, o serviço de flags e o próprio upsertSetting. O teste enumera TODAS as chaves marcadas
// no SETTINGS_SCHEMA e falha se aparecer uma sem valor de prova aqui. Banco descartável. Nunca chama endpoint de MFA.

process.env.PORT = process.env.M9D870_PLATAFORMA_TEST_PORT || '21872';
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d870Http');
const { SETTINGS_SCHEMA, upsertSetting } = require('../../../src/features/settings/settings.service');
const platformSettingKeys = (schema) => Object.keys(schema).filter((key) => schema[key].platformOnly === true);
const flagsService = require('../../../src/features/core-governance/feature-flags/feature-flags.service');
const { openTenantTx } = require('../../../src/features/core-governance/data-quality/retention.tenantTx');

// Valor inicial e valor novo (ambos válidos no dicionário) de cada chave da plataforma.
const PROVAS = {
  'integration.egress.mode': ['enforce', 'log'],
  'integration.ssrf.allowed_schemes': ['https', 'HTTPS'],
  'integration.ssrf.max_redirects': [1, 2],
  'integration.ssrf.max_bytes': [2048, 4096],
  'integration.ssrf.fetch_allowlist': ['nay_document:docs.exemplo.com.br', 'nay_document:docs.outro.com.br'],
  'integration.ssrf.timeout_ms': [2000, 3000],
  'integration.ssrf.allowed_ports': ['443', '443,8443'],
  'integration.ssrf.content_types': ['application/json', 'application/json,application/pdf'],
  'integration.egress.provider_hosts': ['signature-clicksign:app.exemplo.com.br', 'signature-clicksign:app.outro.com.br'],
  'integration.egress.private_hosts': ['storage-s3:minio.empresa.lan', 'storage-s3:minio.outra.lan'],
  'integration.secret.require_company_prefix': [true, false],
};
const KEYS = Object.keys(PROVAS);
const tenantA = () => ({ ...http.state.tenants.A });
const codeOf = (promise) => promise.then(() => null, (err) => err.code || (err.details && err.details.code));
const rowOf = async (companyId, key) => (await http.adminQuery('SELECT id, version FROM governance.config_entries WHERE company_id = $1 AND key = $2', [companyId, key])).rows[0];
const liveOf = async (companyId, key) => (await http.adminQuery('SELECT value FROM core.tenant_settings WHERE company_id = $1 AND key = $2 AND deleted_at IS NULL', [companyId, key])).rows[0];

const clean = async (companyId) => {
  await http.adminQuery('DELETE FROM governance.flag_versions WHERE company_id = $1 AND key = ANY($2)', [companyId, KEYS]);
  await http.adminQuery('DELETE FROM governance.config_entries WHERE company_id = $1 AND key = ANY($2)', [companyId, KEYS]);
  await http.adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = ANY($2)', [companyId, KEYS]);
};
// Semeia o valor inicial declarando a permissão da plataforma, que é o caminho legítimo de seed e de instalação.
const seed = async (key) => openTenantTx(tenantA(), (tx) => upsertSetting(key, PROVAS[key][0], tenantA(), null, tx, { platform: true }));

before(async () => { await http.start(); });
afterEach(async () => { if (!http.state.skip) await clean(http.state.tenants.A.companyId); });
after(async () => { await http.stop(); });
const skipReason = () => http.state.skip;

test('m9d870 R3-M1: a lista de provas cobre todas as chaves marcadas como da plataforma no dicionário', () => {
  assert.deepEqual([...platformSettingKeys(SETTINGS_SCHEMA)].sort(), [...KEYS].sort(), 'chave da plataforma nova precisa de prova neste teste');
});

test('m9d870 R3-M1: PATCH /feature-flags com só governance:flags:manage não grava nenhuma chave da plataforma', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  for (const key of KEYS) await seed(key);
  const listed = await http.call('A:gestor', 'GET', '/feature-flags?kind=CONFIG');
  assert.equal(listed.status, 200);
  for (const key of KEYS) {
    const entry = await rowOf(A.companyId, key);
    assert.ok(entry, `${key} absorvida no registro`);
    const res = await http.call('A:gestor', 'PATCH', '/feature-flags', { id: entry.id, value: PROVAS[key][1], version: entry.version, reason: 'QA-M9 tentativa sem a permissão da plataforma.' });
    assert.deepEqual([res.status, res.body.error.code], [403, 'GOV_FLAG_PLATFORM_ONLY'], key);
    assert.equal((await liveOf(A.companyId, key)).value, PROVAS[key][0], `${key}: o parâmetro não mudou`);
    assert.equal((await rowOf(A.companyId, key)).version, entry.version, `${key}: a versão não subiu`);
  }
});

test('m9d870 R3-M1: o serviço de flags e o upsertSetting, sem declarar a permissão da plataforma, recusam toda chave da plataforma', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  for (const key of KEYS) await seed(key);
  await http.call('A:gestor', 'GET', '/feature-flags?kind=CONFIG');
  for (const key of KEYS) {
    const entry = await rowOf(A.companyId, key);
    const viaFlags = await codeOf(openTenantTx(tenantA(), (tx) => flagsService.updateEntry(tenantA(), { id: entry.id, value: PROVAS[key][1], reason: 'QA-M9 serviço sem permissão.' }, A.userId, tx)));
    assert.equal(viaFlags, 'GOV_FLAG_PLATFORM_ONLY', `${key} via serviço de flags`);
    const viaSettings = await codeOf(openTenantTx(tenantA(), (tx) => upsertSetting(key, PROVAS[key][1], tenantA(), A.userId, tx)));
    assert.equal(viaSettings, 'SETTING_PLATFORM_ONLY', `${key} via upsertSetting`);
    assert.equal((await liveOf(A.companyId, key)).value, PROVAS[key][0], `${key}: o parâmetro não mudou`);
  }
});

test('m9d870 R3-M1: PUT /settings/:key de quem tem settings:update mas não a permissão da plataforma é 403 para toda chave', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  for (const key of KEYS) {
    const res = await http.call('A:gestor', 'PUT', `/settings/${key}`, { value: PROVAS[key][1] });
    assert.ok([401, 403].includes(res.status), `${key}: ${res.status}`);
    assert.equal((await liveOf(A.companyId, key)), undefined, `${key}: nada foi gravado`);
  }
});

test('m9d870 R3-M1: rotina que declara a plataforma continua semeando a chave, e chave comum segue gravável pelo registro', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  await seed('integration.egress.mode');
  assert.equal((await liveOf(A.companyId, 'integration.egress.mode')).value, 'enforce');
  const key = 'governanca.flags.risco_config_absorvida';
  await openTenantTx(tenantA(), (tx) => upsertSetting(key, 'MEDIUM', tenantA(), A.userId, tx));
  await http.adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = $2', [A.companyId, key]);
});
