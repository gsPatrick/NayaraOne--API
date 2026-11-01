'use strict';

// M9-D403 e M9-D408 (reabertura R4-M1): a camada de escrita (restrictedPermissionOf, consultada pelo registro de flags) declara a permissão das chaves de Marketing.
// Banco descartável. Nunca chama endpoint de MFA.
process.env.PORT = process.env.M9D403_ESCRITA_TEST_PORT || require('../_helpers/portaLivre').portaLivre();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d870Http');
const { SETTINGS_SCHEMA, upsertSetting } = require('../../../src/features/settings/settings.service');
const { restrictedPermissionOf } = require('../../../src/features/settings/settingRestricted');
const { openTenantTx } = require('../../../src/features/core-governance/data-quality/retention.tenantTx');

const KEY = 'marketing.public_fields.allowlist';
const tenantA = () => ({ ...http.state.tenants.A });
const rowOf = async (companyId, key) => (await http.adminQuery('SELECT id, version FROM governance.config_entries WHERE company_id = $1 AND key = $2', [companyId, key])).rows[0];
const liveOf = async (companyId, key) => (await http.adminQuery('SELECT value FROM core.tenant_settings WHERE company_id = $1 AND key = $2 AND deleted_at IS NULL', [companyId, key])).rows[0];
const clean = async (companyId) => {
  await http.adminQuery('DELETE FROM governance.flag_versions WHERE company_id = $1 AND key = $2', [companyId, KEY]);
  await http.adminQuery('DELETE FROM governance.config_entries WHERE company_id = $1 AND key = $2', [companyId, KEY]);
  await http.adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = $2', [companyId, KEY]);
};

before(async () => { await http.start(); });
afterEach(async () => { if (!http.state.skip) await clean(http.state.tenants.A.companyId); });
after(async () => { await http.stop(); });

test('m9d403 R4-M1: toda chave de Marketing do dicionário declara a permissão do dono na camada de escrita', () => {
  const keys = Object.keys(SETTINGS_SCHEMA);
  const publicas = keys.filter((k) => k.startsWith('marketing.public_fields.'));
  const cadencia = keys.filter((k) => k.startsWith('marketing.cadencia.'));
  assert.ok(publicas.length === 2 && cadencia.length >= 3, `${publicas.length} públicas, ${cadencia.length} de cadência`);
  for (const key of publicas) assert.equal(restrictedPermissionOf(key), 'marketing:template:manage', key);
  for (const key of cadencia) assert.equal(restrictedPermissionOf(key), 'marketing:automation:manage', key);
  assert.equal(restrictedPermissionOf('marketing.autopublish.classes'), 'marketing:automation:manage');
  assert.equal(restrictedPermissionOf('marketing.url.max_urls_verificadas'), null);
});

test('m9d403 R4-M1: PATCH /feature-flags da allowlist com só governance:flags:manage é 403 e nada é gravado', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  await openTenantTx(tenantA(), (tx) => upsertSetting(KEY, 'publicId,tipo,bairro', tenantA(), null, tx));
  assert.equal((await http.call('A:gestor', 'GET', '/feature-flags?kind=CONFIG')).status, 200);
  const entry = await rowOf(A.companyId, KEY);
  assert.ok(entry, 'a chave foi absorvida no registro');
  const res = await http.call('A:gestor', 'PATCH', '/feature-flags', { id: entry.id, value: 'publicId,tipo,bairro,logradouro,numeroEndereco', version: entry.version, reason: 'QA-M9 tentativa sem marketing:template:manage.' });
  assert.deepEqual([res.status, res.body.error.code], [403, 'GOV_FLAG_KEY_PROTECTED']);
  assert.equal((await liveOf(A.companyId, KEY)).value, 'publicId,tipo,bairro');
  assert.equal((await rowOf(A.companyId, KEY)).version, entry.version);
});
