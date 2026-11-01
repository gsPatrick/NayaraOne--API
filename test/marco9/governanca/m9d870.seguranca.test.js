'use strict';

// M9-D870 (reabertura R4-L1 e R4-L5 da rodada 4): as chaves de segurança do dicionário não mudam só com settings:update, os pisos do livro valem, e POST /feature-flags
// com chave do dicionário não cria entrada divergente do parâmetro real. O teste enumera o SETTINGS_SCHEMA. Banco descartável. Nunca chama endpoint de MFA.

process.env.PORT = process.env.M9D870_SEGURANCA_TEST_PORT || '21873';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d870Http');
const { SETTINGS_SCHEMA, upsertSetting } = require('../../../src/features/settings/settings.service');
const { restrictedPermissionOf } = require('../../../src/features/settings/settingRestricted');
const { openTenantTx } = require('../../../src/features/core-governance/data-quality/retention.tenantTx');
const inventory = require('../../../src/shared/destructive-actions/inventory');

// Chaves que o relatório da rodada 4 reproduziu como graváveis só com settings:update.
const REPRODUZIDAS = [
  'migracao.relogio.ntp_ativo', 'migracao.relogio.deriva_max_s', 'migracao.legado.exigir_filtro_multiempresa', 'migracao.dry3.dados_pessoais_em_claro', 'migracao.payload.retencao_dias',
  'migracao.execucao.max_por_fonte', 'migracao.execucao.max_por_empresa', 'migracao.execucao.max_no_processo', 'migracao.execucao.expira_min', 'migracao.execucao.expira_replay_min',
  'governanca.dlp.justificativa_min', 'governanca.api.rate_limit.habilitado', 'governanca.ui.confirmacao_por_nivel', 'governanca.flags.risco_padrao',
];
const OWN = 'governance:flags:manage'; // permissão que o perfil de teste tem (além de settings:update, dada abaixo)
const tenantA = () => ({ ...http.state.tenants.A });
const codeOf = (promise) => promise.then(() => null, (err) => err.code || (err.details && err.details.code));
const sampleValue = (spec) => (spec.type === 'boolean' ? false : spec.type === 'integer' ? spec.min : 'x');

async function grantSettingsUpdate(on) {
  const sql = on
    ? "INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at) SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = 'CI GESTOR' AND p.code = 'settings:update' AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)"
    : "DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = 'CI GESTOR' AND p.code = 'settings:update'";
  await http.adminQuery(sql);
}

before(async () => { await http.start(); if (!http.state.skip) await grantSettingsUpdate(true); });
after(async () => { if (!http.state.skip) await grantSettingsUpdate(false); await http.stop(); });
const skipReason = () => http.state.skip;

test('m9d870 R4-L1: toda chave reproduzida pelo relatório tem permissão própria no dicionário', () => {
  for (const key of REPRODUZIDAS) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} existe no dicionário`);
    assert.ok(restrictedPermissionOf(key), `${key} exige permissão própria`);
  }
  assert.equal(restrictedPermissionOf('governanca.dlp.justificativa_min'), 'governance:dlp:admin');
  assert.equal(restrictedPermissionOf('governanca.api.rate_limit.habilitado'), 'governance:api:manage');
  assert.equal(restrictedPermissionOf('migracao.payload.retencao_dias'), 'governance:migration:admin');
});

test('m9d870 R4-L1: PUT /settings de TODA chave restrita é 403 para quem tem settings:update sem a permissão do dono', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const restritas = Object.keys(SETTINGS_SCHEMA).filter((key) => restrictedPermissionOf(key) && restrictedPermissionOf(key) !== OWN);
  for (const key of REPRODUZIDAS.filter((k) => restrictedPermissionOf(k) !== OWN)) assert.ok(restritas.includes(key), key);
  for (const key of restritas) {
    const res = await http.call('A:gestor', 'PUT', `/settings/${key}`, { value: sampleValue(SETTINGS_SCHEMA[key]) });
    assert.equal(res.status, 403, `${key}: ${res.status}`);
    const row = (await http.adminQuery('SELECT 1 FROM core.tenant_settings WHERE company_id = $1 AND key = $2 AND deleted_at IS NULL', [A.companyId, key])).rowCount;
    assert.equal(row, 0, `${key}: nada foi gravado`);
  }
});

test('m9d870 R4-L1: os pisos do livro valem (justificativa 20, retenção de payload acima de 0, nível de confirmação do livro)', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const A = tenantA();
  const tryWrite = (key, value) => codeOf(openTenantTx(A, (tx) => upsertSetting(key, value, A, A.userId, tx, { platform: true })));
  assert.equal(await tryWrite('governanca.dlp.justificativa_min', 19), 'SETTING_INVALID_VALUE');
  assert.equal(await tryWrite('governanca.dlp.justificativa_min', 20), null);
  assert.equal(await tryWrite('migracao.payload.retencao_dias', 0), 'SETTING_INVALID_VALUE');
  const high = inventory.all().find((a) => a.level === 3);
  assert.equal(await tryWrite('governanca.ui.confirmacao_por_nivel', `${high.key}=1`), 'SETTING_INVALID_VALUE', 'afrouxar abaixo do livro é recusado');
  assert.equal(await tryWrite('governanca.ui.confirmacao_por_nivel', `${high.key}=3`), null, 'endurecer ou manter é aceito');
  await http.adminQuery("DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = ANY($2)", [A.companyId, ['governanca.dlp.justificativa_min', 'governanca.ui.confirmacao_por_nivel']]);
});

test('m9d870 R4-L5: POST /feature-flags com chave do dicionário é recusado e não cria entrada divergente', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const key = 'governanca.finops.degradacao.ligada';
  const res = await http.call('A:gestor', 'POST', '/feature-flags', { kind: 'CONFIG', key, value: 100, valueType: 'INTEGER', ownerUserId: A.userId, scope: 'COMPANY', scopeRef: A.companyId, risk: 'LOW', reason: 'QA-M9 tentativa de divergir do parâmetro.' });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.match(res.body.error.message, /parâmetro das Configurações/, 'recusado por ser chave do dicionário, não por outro motivo');
  const rows = (await http.adminQuery('SELECT 1 FROM governance.config_entries WHERE company_id = $1 AND key = $2', [A.companyId, key])).rowCount;
  assert.equal(rows, 0, 'nenhuma entrada manual criada');
});
