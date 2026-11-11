'use strict';

// M9-D870 (reabertura R4-M1 e R4-L3, vindo da M9-D403 e da M9-D408): a camada de escrita declara a permissão de cada chave do SETTINGS_SCHEMA e TODOS os caminhos a consultam
// (PUT /settings, PATCH e POST /feature-flags, upsertSetting). O teste enumera o dicionário inteiro. A tentativa negada gera linha em audit.audit_log. Banco descartável. Nunca chama MFA.
process.env.PORT = process.env.M9D870_ESCRITA_TEST_PORT || require('../_helpers/portaLivre').portaLivre();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d870Http');
const { SETTINGS_SCHEMA, upsertSetting } = require('../../../src/features/settings/settings.service');
const { resetDeniedWindows } = require('../../../src/features/settings/settingDenied');
const { restrictedPermissionOf } = require('../../../src/features/settings/settingRestricted');
const { isPlatformOnly } = require('../../../src/features/settings/settingPlatform');
const { absorbable } = require('../../../src/features/core-governance/feature-flags/flags.settings.adapter');
const { openTenantTx } = require('../../../src/features/core-governance/data-quality/retention.tenantTx');

const tenantA = () => ({ ...http.state.tenants.A });
const state = { perms: [] };
const typeOf = (spec) => (spec.type === 'boolean' ? 'BOOLEAN' : spec.type === 'integer' ? 'INTEGER' : 'STRING');
const sample = (spec) => (Array.isArray(spec.enum) && spec.enum.length ? spec.enum[0] : spec.type === 'boolean' ? false : spec.type === 'integer' ? spec.min : 'x');
const required = (key) => restrictedPermissionOf(key) || (isPlatformOnly(SETTINGS_SCHEMA[key]) ? 'integration:platform' : null);
const blocked = () => Object.keys(SETTINGS_SCHEMA).filter((key) => required(key) && !state.perms.includes(required(key)));
const denials = async (companyId, key) => (await http.adminQuery("SELECT after_json FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.setting.write_denied' AND after_json->>'key' = $2 ORDER BY occurred_at", [companyId, key])).rows;
const live = async (companyId, key) => (await http.adminQuery('SELECT 1 FROM core.tenant_settings WHERE company_id = $1 AND key = $2 AND deleted_at IS NULL', [companyId, key])).rowCount;

/** Grava pelo caminho interno (sem permissões de sessão) um valor que o dicionário aceita para a chave. */
async function seedInternally(key, spec) {
  for (const value of [sample(spec), 'publicId', 'piscina', 'tipo', 'bloquear', 'exemplo.com.br', '1,3', '09:00', '1', '[]', '99.5% / p95 5 s / p99 12 s / backlog 15 min']) {
    const ok = await openTenantTx(tenantA(), (tx) => upsertSetting(key, value, tenantA(), null, tx)).then(() => true, () => false);
    if (ok) return value;
  }
  throw new Error(`sem valor aceito para ${key}`);
}
const revokeSettingsUpdate = () => http.adminQuery("DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = 'CI GESTOR' AND p.code = 'settings:update'");

before(async () => {
  await http.start(['settings:update']); // o token do gestor já nasce com settings:update (o token é emitido no login)
  if (http.state.skip) return;
  state.perms = (await http.adminQuery("SELECT p.code FROM core.role_permissions rp JOIN core.roles r ON r.id = rp.role_id JOIN core.permissions p ON p.id = rp.permission_id WHERE r.name = 'CI GESTOR'")).rows.map((row) => row.code);
});
after(async () => {
  if (!http.state.skip) {
    const keys = [...new Set(blocked().concat('marketing.public_fields.allowlist'))];
    await http.adminQuery('DELETE FROM governance.flag_versions WHERE key = ANY($1)', [keys]);
    await http.adminQuery('DELETE FROM governance.config_entries WHERE key = ANY($1)', [keys]);
    await http.adminQuery('DELETE FROM core.tenant_settings WHERE key = ANY($1)', [keys]);
    await revokeSettingsUpdate();
  }
  await http.stop();
});

test('m9d870 R4-M1: a camada de escrita recusa toda chave protegida do dicionário para quem não tem a permissão do dono (upsertSetting)', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const keys = blocked();
  assert.ok(keys.length > 50, `${keys.length} chaves protegidas enumeradas`);
  for (const must of ['marketing.public_fields.allowlist', 'marketing.public_fields.features_permitidas', 'marketing.autopublish.classes']) assert.ok(keys.includes(must), must);
  assert.ok(keys.some((k) => k.startsWith('marketing.cadencia.')));
  const A = tenantA();
  // outros arquivos no mesmo banco podem ter deixado parâmetros protegidos vivos (gravados por quem tem a permissão): o que se afirma é que ESTE teste não gravou nenhum
  const liveKeys = async () => (await http.adminQuery('SELECT key FROM core.tenant_settings WHERE company_id = $1 AND key = ANY($2) AND deleted_at IS NULL ORDER BY key', [A.companyId, keys])).rows.map((r) => r.key);
  const antes = await liveKeys();
  for (const key of keys) {
    const err = await openTenantTx(A, (tx) => upsertSetting(key, sample(SETTINGS_SCHEMA[key]), A, A.userId, tx, { permissions: state.perms })).then(() => null, (e) => e);
    assert.ok(err && err.statusCode === 403, `${key}: ${err && err.statusCode}`);
    assert.ok(['SETTING_PERMISSION_REQUIRED', 'SETTING_PLATFORM_ONLY'].includes(err.code), `${key}: ${err.code}`);
  }
  assert.deepEqual(await liveKeys(), antes, 'nada foi gravado');
});

test('m9d870 R4-M1: com a permissão do dono a camada grava (marketing:template:manage na allowlist)', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const A = tenantA();
  const key = 'marketing.public_fields.allowlist';
  await openTenantTx(A, (tx) => upsertSetting(key, 'publicId,tipo', A, A.userId, tx, { permissions: [...state.perms, 'marketing:template:manage'] }));
  assert.equal(await live(A.companyId, key), 1);
  await http.adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = $2', [A.companyId, key]);
});

test('m9d870 R4-M1 e R4-L3: PUT, PATCH e POST de chave protegida dão 403, nada é gravado e cada tentativa gera linha em audit.audit_log', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  const byPermission = new Map();
  for (const key of blocked().filter((k) => absorbable(k) && !isPlatformOnly(SETTINGS_SCHEMA[k]) && ['boolean', 'integer', 'string'].includes(SETTINGS_SCHEMA[k].type))) if (!byPermission.has(required(key))) byPermission.set(required(key), key);
  for (const key of ['marketing.public_fields.allowlist', 'marketing.public_fields.features_permitidas', 'marketing.autopublish.classes', 'marketing.url.revisao_sem_aprovador', 'marketing.url.dominios_permitidos', blocked().find((k) => k.startsWith('marketing.cadencia.'))]) byPermission.set(`${required(key)}#${key}`, key);
  assert.ok(byPermission.size >= 8, `${byPermission.size} chaves amostradas`);
  for (const key of byPermission.values()) {
    const spec = SETTINGS_SCHEMA[key];
    const seeded = await seedInternally(key, spec); // gravação interna (sem sessão), para a chave aparecer no registro
    assert.equal((await http.call('A:gestor', 'GET', `/feature-flags?kind=CONFIG&key=${encodeURIComponent(key)}`)).status, 200);
    const entry = (await http.adminQuery('SELECT id, version FROM governance.config_entries WHERE company_id = $1 AND key = $2', [A.companyId, key])).rows[0];
    assert.ok(entry, `${key} absorvida`);
    resetDeniedWindows(); // a agregação por janela (R5-L2) é testada à parte: aqui cada tentativa conta
    const already = (await denials(A.companyId, key)).length; // a trilha é só de inserção: conta só as linhas novas
    const put = await http.call('A:gestor', 'PUT', `/settings/${key}`, { value: seeded });
    const patchValue = spec.type === 'boolean' ? !sample(spec) : spec.type === 'integer' ? spec.min + 1 : 'publicId';
    const patch = await http.call('A:gestor', 'PATCH', '/feature-flags', { id: entry.id, value: patchValue, version: entry.version, reason: 'QA-M9 tentativa sem a permissão do dono.' });
    const post = await http.call('A:gestor', 'POST', '/feature-flags', { kind: 'CONFIG', key, value: seeded, valueType: typeOf(spec), ownerUserId: A.userId, scope: 'COMPANY', scopeRef: A.companyId, risk: 'LOW', reason: 'QA-M9 tentativa.' });
    assert.deepEqual([put.status, patch.status, post.status], [403, 403, 403], `${key}: ${JSON.stringify([put.body, patch.body, post.body])}`);
    assert.equal((await http.adminQuery('SELECT version FROM governance.config_entries WHERE id = $1', [entry.id])).rows[0].version, entry.version, `${key}: versão intacta`);
    const rows = (await denials(A.companyId, key)).slice(already);
    assert.deepEqual(rows.map((r) => r.after_json.via).sort(), ['PATCH /feature-flags', 'POST /feature-flags', 'PUT /settings'], `${key}: uma linha de auditoria por tentativa`);
    assert.ok(rows.every((r) => r.after_json.key === key));
  }
});

test('m9d870 R4-M1 e R4-L3: chave protegida que o registro não absorve por formato (ex.: integration.slo.CRITICAL) dá 403 no PUT e a tentativa é auditada', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  const keys = blocked().filter((k) => !absorbable(k) && !isPlatformOnly(SETTINGS_SCHEMA[k]) && ['boolean', 'integer', 'string'].includes(SETTINGS_SCHEMA[k].type));
  assert.ok(keys.some((k) => k.startsWith('integration.slo.')), 'chaves integration.slo.* enumeradas');
  for (const key of keys.slice(0, 6).concat(keys.filter((k) => k.startsWith('integration.slo.')).slice(0, 2))) {
    resetDeniedWindows();
    const already = (await denials(A.companyId, key)).length;
    const put = await http.call('A:gestor', 'PUT', `/settings/${key}`, { value: sample(SETTINGS_SCHEMA[key]) });
    assert.equal(put.status, 403, `${key}: ${JSON.stringify(put.body)}`);
    assert.equal(await live(A.companyId, key), 0, `${key}: nada gravado`);
    assert.equal((await denials(A.companyId, key)).length - already, 1, `${key}: uma linha de auditoria`);
  }
});

test('m9d870 R4-L3: tentativa em chave comum (sem proteção) não gera linha de tentativa negada', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  const before = (await http.adminQuery("SELECT 1 FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.setting.write_denied'", [A.companyId])).rowCount;
  const res = await http.call('A:leitura', 'PUT', '/settings/governanca.api.paginacao.tamanho_padrao', { value: 50 });
  assert.equal(res.status, 403);
  const after = (await http.adminQuery("SELECT 1 FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.setting.write_denied'", [A.companyId])).rowCount;
  assert.equal(after, before);
});
