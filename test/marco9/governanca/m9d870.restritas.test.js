'use strict';

// M9-D870 (reabertura R3-M1, mesma família): as chaves da NAY (ai:admin) e as metas de SLO (integration:manage) também não mudam pelo registro de flags
// (PATCH /feature-flags com gravação nos parâmetros) de quem tem só governance:flags:manage. Banco descartável. Nunca chama endpoint de MFA.
process.env.PORT = process.env.M9D870_RESTRITAS_TEST_PORT || require('../_helpers/portaLivre').portaLivre();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d870Http');
const { SETTINGS_SCHEMA, upsertSetting } = require('../../../src/features/settings/settings.service');
const { isAiSettingKey } = require('../../../src/features/ai/ai.settings');
const { isSloSettingKey } = require('../../../src/features/integrations/health/slo');
const { restrictedPermissionOf } = require('../../../src/features/settings/settingRestricted');
const flagsService = require('../../../src/features/core-governance/feature-flags/feature-flags.service');
const { openTenantTx } = require('../../../src/features/core-governance/data-quality/retention.tenantTx');

const AI_KEY = 'ia.agente.max_tool_calls_por_run';
const SLO_KEY = 'integration.slo.LOW';
const tenantA = () => ({ ...http.state.tenants.A });
const codeOf = (promise) => promise.then(() => null, (err) => err.code || (err.details && err.details.code));
const rowOf = async (companyId, key) => (await http.adminQuery('SELECT id, version FROM governance.config_entries WHERE company_id = $1 AND key = $2', [companyId, key])).rows[0];
const liveOf = async (companyId, key) => (await http.adminQuery('SELECT value FROM core.tenant_settings WHERE company_id = $1 AND key = $2 AND deleted_at IS NULL', [companyId, key])).rows[0];
const clean = async (companyId) => {
  await http.adminQuery('DELETE FROM governance.flag_versions WHERE company_id = $1 AND key = ANY($2)', [companyId, [AI_KEY, SLO_KEY]]);
  await http.adminQuery('DELETE FROM governance.config_entries WHERE company_id = $1 AND key = ANY($2)', [companyId, [AI_KEY, SLO_KEY]]);
  await http.adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = ANY($2)', [companyId, [AI_KEY, SLO_KEY]]);
};

before(async () => { await http.start(); });
afterEach(async () => { if (!http.state.skip) await clean(http.state.tenants.A.companyId); });
after(async () => { await http.stop(); });

test('m9d870 R3-M1: toda chave da NAY e toda meta de SLO do dicionário exige a permissão própria', () => {
  const keys = Object.keys(SETTINGS_SCHEMA);
  const ai = keys.filter(isAiSettingKey);
  const slo = keys.filter(isSloSettingKey);
  assert.ok(ai.length > 10 && slo.length === 4);
  for (const key of ai) assert.equal(restrictedPermissionOf(key), 'ai:admin', key);
  for (const key of slo) assert.equal(restrictedPermissionOf(key), 'integration:manage', key);
  assert.equal(restrictedPermissionOf('governanca.api.paginacao.tamanho_padrao'), null);
});

test('m9d870 R3-M1: PATCH /feature-flags de chave da NAY com só governance:flags:manage é 403 e nada é gravado', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  await openTenantTx(tenantA(), (tx) => upsertSetting(AI_KEY, 5, tenantA(), null, tx));
  assert.equal((await http.call('A:gestor', 'GET', '/feature-flags?kind=CONFIG')).status, 200);
  const entry = await rowOf(A.companyId, AI_KEY);
  assert.ok(entry, 'a chave da NAY foi absorvida no registro');
  const res = await http.call('A:gestor', 'PATCH', '/feature-flags', { id: entry.id, value: 9, version: entry.version, reason: 'QA-M9 tentativa sem ai:admin.' });
  assert.deepEqual([res.status, res.body.error.code], [403, 'GOV_FLAG_KEY_PROTECTED']);
  assert.equal((await liveOf(A.companyId, AI_KEY)).value, 5);
  assert.equal((await rowOf(A.companyId, AI_KEY)).version, entry.version);
});

test('m9d870 R3-M1: o serviço de flags recusa criar e editar chave da NAY e meta de SLO', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  await openTenantTx(tenantA(), (tx) => upsertSetting(AI_KEY, 5, tenantA(), null, tx));
  await http.call('A:gestor', 'GET', '/feature-flags?kind=CONFIG');
  const entry = await rowOf(A.companyId, AI_KEY);
  const editar = await codeOf(openTenantTx(tenantA(), (tx) => flagsService.updateEntry(tenantA(), { id: entry.id, value: 9, reason: 'QA-M9 serviço sem ai:admin.' }, A.userId, tx)));
  assert.equal(editar, 'GOV_FLAG_KEY_PROTECTED');
  const criarSlo = await http.call('A:gestor', 'POST', '/feature-flags', { kind: 'CONFIG', key: SLO_KEY, value: '99.9', valueType: 'STRING', ownerUserId: A.userId, scope: 'COMPANY', reason: 'QA-M9 tentativa sem integration:manage.' });
  assert.ok([403, 422].includes(criarSlo.status), `SLO via registro: ${criarSlo.status}`);
  assert.equal(await liveOf(A.companyId, SLO_KEY), undefined);
  assert.equal((await liveOf(A.companyId, AI_KEY)).value, 5);
});
