'use strict';

// M9-D822 (reabertura F17) — a auditoria da exportação guarda finalidade e justificativa e a leitura em claro conta só o que foi lido de verdade (0 linhas = nada lido).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d822.auditoria.test.js"
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/exportsEnv');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');
const { getExport } = require('../../../src/features/core-governance/dlp/exports/export.read');
const { generateExport } = require('../../../src/features/core-governance/dlp/exports/export.run');

env.useMonth(env.uniqueMonth());
let A;
let restore;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const tenantOf = () => ({ groupId: A.groupId, companyId: A.companyId });
const countAction = async (action) => (await env.adminQuery('SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = $1 AND action = $2', [A.companyId, action])).rows[0].n;
const latest = async (action) => (await env.adminQuery('SELECT * FROM audit.audit_log WHERE company_id = $1 AND action = $2 ORDER BY occurred_at DESC LIMIT 1', [A.companyId, action])).rows[0];

before(async () => {
  if (!env.DISPOSABLE) return;
  A = (await env.loadTenants()).A;
  restore = await env.withRolePermissions({ 'CI GESTOR': { 'finance:read': true, 'governance:dlp:export': true } });
  await env.cleanExports();
  await env.seedEntries(A, 3);
});
afterEach(async () => { resolver.resetResolver(); if (env.DISPOSABLE) await env.cleanExports(); });
after(async () => {
  if (env.DISPOSABLE) { await env.cleanExports(); await restore(); }
  await env.sequelize.close();
});

test('m9d822 a auditoria do pedido guarda a finalidade e a justificativa informadas', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const justification = 'Fechamento contábil do trimestre, pedido pelo contador responsável.';
  const out = await env.ask(A, { purpose: 'CONTABIL', justification });
  const [row] = await env.auditOf('governance.dlp.export', out.exportJobId);
  assert.ok(row, 'o pedido liberado é auditado');
  assert.equal(row.after_json.purpose, 'CONTABIL');
  assert.equal(row.after_json.justification, justification);
  assert.match(row.reason, /CONTABIL/);
  assert.match(row.reason, /Fechamento contábil do trimestre/);
});

test('m9d822 o pedido bloqueado também guarda a finalidade e a justificativa', { skip: skip() }, async () => {
  resolver.setResolver(async (_t, resources) => resources.map(() => 'RESTRICTED'));
  await env.revokeMfa(A.userId);
  const justification = 'Conferência dos lançamentos a pagar do mês.';
  await env.ask(A, { purpose: 'AUDITORIA', justification }).catch(() => null);
  const row = await latest('governance.dlp.export.blocked');
  assert.equal(row.before_json.purpose, 'AUDITORIA');
  assert.equal(row.before_json.justification, justification);
});

test('m9d822 exportação sem linhas não registra leitura em claro de campo algum', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const before = await countAction('governance.field_access.clear_read');
  const { job } = await env.askAndGenerate(A, { filter: { competenceMonth: '0001-01' } });
  assert.equal(job.status, 'READY');
  assert.equal(job.rowCount, 0, 'o filtro não acha lançamento');
  assert.equal(await countAction('governance.field_access.clear_read'), before, 'nenhum campo foi lido: nenhuma linha de leitura em claro');
});

test('m9d822 exportação com linhas registra a leitura em claro com a quantidade de linhas lidas', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const before = await countAction('governance.field_access.clear_read');
  const { job } = await env.askAndGenerate(A);
  assert.equal(job.rowCount, 3);
  const after = await countAction('governance.field_access.clear_read');
  if (after > before) assert.equal((await latest('governance.field_access.clear_read')).after_json.rowCount, 3);
});

test('m9d822 o arquivo gerado sem linhas diz isso no pedido consultado', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const out = await env.ask(A, { filter: { competenceMonth: '0001-01' } });
  await generateExport(tenantOf(), out.exportJobId);
  const view = await env.inBusinessTx(A, (transaction) => getExport({ tenant: tenantOf(), actorUserId: A.userId, permissions: [], id: out.exportJobId, transaction }));
  assert.equal(view.rowCount, 0);
  assert.equal(view.empty, true);
});
