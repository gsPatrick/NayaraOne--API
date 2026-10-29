'use strict';

// M9-D830 — catálogo dos seis setores (tabela governance.bcp_sectors) e vínculo usuário-setor derivado do papel (userSectors), em banco descartável.
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d830.catalogo.test.js"
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/bcpEnv');
const { SECTORS, SECTOR_CODES } = require('../../../src/features/core-governance/bcp/bcp.constants');
const { userSectors, listSectors } = require('../../../src/features/core-governance/bcp/bcp.sectors');
const settings = require('../../../src/features/core-governance/bcp/bcp.settings');

let A;
let B;
let makerId;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const sectorsOf = (tenant, userId) => env.inTx(tenant, (tx) => userSectors(userId, env.tenantOf(tenant), tx), userId);

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A, B } = await env.loadTenants());
  makerId = await env.otherUserId();
  await env.cleanBcp();
});
after(async () => { if (env.DISPOSABLE) { await env.cleanBcp(); await env.sequelize.close(); } });

test('m9d830 catálogo de setores tem exatamente seis linhas com os prefixos ATD, LOC, FIN, OBR, COR e JUR', { skip: skip() }, async () => {
  const rows = (await env.adminQuery('SELECT sector, form_prefix, runbook_file FROM governance.bcp_sectors ORDER BY position')).rows;
  assert.deepEqual(rows.map((r) => [r.sector, r.form_prefix, r.runbook_file]), [
    ['ATENDIMENTO', 'ATD', 'atendimento.md'], ['LOCACAO', 'LOC', 'locacao.md'], ['FINANCEIRO', 'FIN', 'financeiro.md'],
    ['OBRAS', 'OBR', 'obras.md'], ['CORRESPONDENTE', 'COR', 'correspondente.md'], ['JURIDICO', 'JUR', 'juridico.md'],
  ]);
  assert.deepEqual(SECTORS.map((s) => [s.sector, s.prefix, s.runbook]), rows.map((r) => [r.sector, r.form_prefix, r.runbook_file]), 'o código e a tabela coincidem');
  const viaApp = await env.inTx(A, (tx) => listSectors(tx));
  assert.equal(viaApp.length, 6, 'o papel de execução da API lê os seis setores');
});

test('m9d830 userSectors deriva o setor do papel e o administrador pertence aos seis', { skip: skip() }, async () => {
  await env.setSectorRoles(A, { FINANCEIRO: ['ci gestor'], OBRAS: ['CI GESTOR', 'OUTRO'], JURIDICO: ['CI MAKER'] });
  assert.deepEqual(await sectorsOf(A, A.userId), ['FINANCEIRO', 'OBRAS'], 'o nome do papel casa sem diferenciar maiúsculas, na ordem do catálogo');
  assert.deepEqual(await sectorsOf(A, makerId), ['JURIDICO']);
  const admin = (await env.adminQuery("SELECT u.id FROM core.users u JOIN core.user_memberships m ON m.user_id = u.id JOIN core.roles r ON r.id = m.role_id WHERE r.name = 'ADMIN' AND m.company_id = $1 LIMIT 1", [A.companyId])).rows[0];
  if (admin) assert.deepEqual(await sectorsOf(A, admin.id), SECTOR_CODES, 'ADMIN pertence aos seis setores');
});

test('m9d830 o administrador do grupo pertence aos seis setores (papel ADMIN criado na empresa)', { skip: skip() }, async () => {
  const [{ id: roleId }] = (await env.adminQuery("INSERT INTO core.roles (id, group_id, company_id, name, is_system, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'ADMIN', false, now(), now()) RETURNING id", [A.groupId, A.companyId])).rows;
  const membership = (await env.adminQuery('SELECT id, role_id FROM core.user_memberships WHERE user_id = $1 AND company_id = $2 LIMIT 1', [makerId, A.companyId])).rows[0];
  try {
    await env.adminQuery('UPDATE core.user_memberships SET role_id = $1 WHERE id = $2', [roleId, membership.id]);
    assert.deepEqual(await sectorsOf(A, makerId), SECTOR_CODES);
  } finally {
    await env.adminQuery('UPDATE core.user_memberships SET role_id = $1 WHERE id = $2', [membership.role_id, membership.id]);
    await env.adminQuery('DELETE FROM core.roles WHERE id = $1', [roleId]);
  }
});

test('m9d830 usuário sem papel mapeado não tem setor, e o mapa é por empresa', { skip: skip() }, async () => {
  await env.setSectorRoles(A, { FINANCEIRO: ['PAPEL QUE NINGUEM TEM'] });
  assert.deepEqual(await sectorsOf(A, A.userId), []);
  assert.deepEqual(await sectorsOf(A, makerId), []);
  await env.setSectorRoles(A, { FINANCEIRO: ['CI GESTOR'] });
  assert.deepEqual(await sectorsOf(A, A.userId), ['FINANCEIRO']);
  assert.deepEqual(await sectorsOf(B, B.userId), [], 'a empresa B não herda o mapa da A (padrão do parâmetro: nomes de uso comum)');
});

test('m9d830 o padrão do parâmetro é válido e o schema recusa setor desconhecido ou formato inválido', { skip: skip() }, async () => {
  assert.ok(settings.parseSectorRoles(settings.BCP_SETTING_DEFAULTS[settings.SECTOR_ROLES_KEY]), 'o padrão passa no próprio validador');
  for (const bad of ['{"OUTRO":["X"]}', '[1]', '{"FINANCEIRO":"X"}', '{"FINANCEIRO":[""]}', 'não é json']) {
    assert.equal(settings.parseSectorRoles(bad), null, bad);
    assert.throws(() => settings.BCP_SETTINGS_SCHEMA[settings.SECTOR_ROLES_KEY].validate(settings.SECTOR_ROLES_KEY, bad), (e) => e.code === 'VALIDATION_ERROR', bad);
  }
});
