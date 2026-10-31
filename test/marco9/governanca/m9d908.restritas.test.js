'use strict';

// M9-D908 (reabertura R3-L3): os parâmetros do portão do corte (validade, volume e commit do relatório DRY3, comparação paralela exigida e etapas do canary) só mudam com
// governance:migration:admin, além de settings:update, tanto na rota PUT /settings quanto no registro de flags. Banco descartável. Nunca chama endpoint de MFA.
process.env.PORT = process.env.M9D908_RESTRITAS_TEST_PORT || require('../_helpers/portaLivre').portaLivre();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d870Http');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { restrictedPermissionOf } = require('../../../src/features/settings/settingRestricted');
const { GATE_KEYS } = require('../../../src/features/migration-v2/migration.gateKeys');

const ROLE = 'CI GESTOR';
const KEY = 'migracao.dry3.validade_horas';
const grant = (code) => http.adminQuery('INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at) SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = $2 AND NOT EXISTS (SELECT 1 FROM core.role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id)', [ROLE, code]);
const revoke = (code) => http.adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = $2', [ROLE, code]);
const clean = () => http.adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = ANY($2)', [http.state.tenants.A.companyId, GATE_KEYS]);

before(async () => { await http.adminQuery('SELECT 1'); await grant('settings:update'); await http.start(); });
after(async () => { await revoke('settings:update'); await revoke('governance:migration:admin'); await clean(); await http.stop(); });

test('m9d908 R3-L3: cada parâmetro do portão do corte existe no dicionário e exige governance:migration:admin', () => {
  assert.equal(GATE_KEYS.length, 5);
  for (const key of GATE_KEYS) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} no dicionário`);
    assert.equal(restrictedPermissionOf(key), 'governance:migration:admin', key);
  }
  assert.equal(restrictedPermissionOf('migracao.dry3.timeout_min'), null);
});

test('m9d908 R3-L3: PUT /settings do portão sem governance:migration:admin é 403; com a permissão, grava', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  const before = await http.call('A:gestor', 'PUT', '/settings/migracao.dry3.timeout_min', { value: 600 });
  assert.equal(before.status, 200, 'o gestor tem settings:update: parâmetro comum grava');
  for (const key of GATE_KEYS) {
    const value = key.endsWith('etapas') ? '10,100' : key.includes('exigir') ? false : 24;
    const res = await http.call('A:gestor', 'PUT', `/settings/${key}`, { value });
    assert.equal(res.status, 403, `${key}: ${res.status}`);
  }
  assert.equal((await http.adminQuery('SELECT count(*)::int AS n FROM core.tenant_settings WHERE company_id = $1 AND key = ANY($2) AND deleted_at IS NULL', [A.companyId, GATE_KEYS])).rows[0].n, 0, 'nada foi gravado');
  await grant('governance:migration:admin');
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  const login = await fetch(`${http.state.baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor('A', 'gestor'), password: process.env.CI_TENANT_USERS_PASSWORD }) });
  http.state.tokens['A:admin'] = (await login.json()).data.accessToken;
  assert.equal((await http.call('A:admin', 'PUT', `/settings/${KEY}`, { value: 24 })).status, 200);
});
