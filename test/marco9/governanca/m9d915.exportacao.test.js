'use strict';

// M9-D915 — exportabilidade pelo registro: coluna FORBIDDEN fora do arquivo (com aviso) ou pedido recusado (403) quando listada; ALLOWED_MASKED mascarada; WITH_APPROVAL em claro
// só depois do guard (sem fluxo humano). Banco descartável: ver m9d915.campo.test.js.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const exportsEnv = require('../_helpers/exportsEnv');
const reg = require('../_helpers/m9d915Env');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');
const { downloadExport } = require('../../../src/features/core-governance/dlp/exports/export.download');
const { getExport } = require('../../../src/features/core-governance/dlp/exports/export.read');
const { signDownloadUrl } = require('../../../src/features/core-governance/dlp/exports/export.url');
const { maskExportRows } = require('../../../src/features/core-governance/data-quality/fieldAccess.export');
const financeEntries = require('../../../src/features/core-governance/dlp/exports/catalog/financeEntries');

exportsEnv.useMonth(exportsEnv.uniqueMonth());
const FIN = { schema: 'finance', table: 'financial_entries' };
let A;
let tenantRef;
let restore;
const skip = () => (exportsEnv.DISPOSABLE ? false : exportsEnv.SKIP_DISPOSABLE);

before(async () => {
  if (!exportsEnv.DISPOSABLE) return;
  A = (await exportsEnv.loadTenants()).A;
  tenantRef = { groupId: A.groupId, companyId: A.companyId };
  restore = await exportsEnv.withRolePermissions({ 'CI GESTOR': { 'finance:read': true, 'governance:dlp:export': true } });
  await exportsEnv.cleanExports();
  await reg.ensure(A);
  await exportsEnv.seedEntries(A, 3);
  await exportsEnv.grantMfa(A);
});
afterEach(async () => { resolver.resetResolver(); if (exportsEnv.DISPOSABLE) { await exportsEnv.cleanExports(); await exportsEnv.grantMfa(A); } });
after(async () => {
  if (exportsEnv.DISPOSABLE) { await exportsEnv.cleanExports(); await restore(); }
  await exportsEnv.sequelize.close();
});

const csvOf = async (job) => {
  const u = new URL(signDownloadUrl({ jobId: job.id, userId: job.actorUserId, now: new Date(), urlMinutes: 15, fileExpiresAt: job.expiresAt }).url, 'http://x');
  const file = await downloadExport({ tenant: tenantRef, actorUserId: A.userId, permissions: [], id: job.id, exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') });
  return file.buffer.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split('\n');
};
const jobsCount = async () => (await exportsEnv.adminQuery('SELECT count(*)::int AS n FROM governance.export_jobs WHERE company_id = $1', [A.companyId])).rows[0].n;
const viewOf = (id) => exportsEnv.inBusinessTx(A, (tx) => getExport({ tenant: tenantRef, actorUserId: A.userId, permissions: [], id, transaction: tx }));

test('m9d915 coluna FORBIDDEN some do arquivo exportado e o pedido sem colunas sai com aviso', { skip: skip() }, async () => {
  await reg.withColumn(A, 'nature', { exportability: 'FORBIDDEN' }, async () => {
    const { out, job } = await exportsEnv.askAndGenerate(A);
    assert.equal(job.status, 'READY');
    const lines = await csvOf(job);
    assert.ok(!lines[0].includes('Natureza'), `cabeçalho sem a coluna proibida: ${lines[0]}`);
    assert.ok(lines[0].includes('Valor'), 'as demais colunas continuam');
    assert.ok(!lines.join('\n').includes('PAYABLE'), 'o valor da coluna proibida não está em lugar nenhum do arquivo');
    assert.deepEqual((await viewOf(out.exportJobId)).warnings, ['coluna nature omitida'], 'o aviso vai na resposta de GET /exports/:id');
  }, FIN);
});

test('m9d915 FORBIDDEN listado em columns devolve 403 e omitido por padrão sai com aviso', { skip: skip() }, async () => {
  await reg.withColumn(A, 'nature', { exportability: 'FORBIDDEN' }, async () => {
    const before = await jobsCount();
    const err = await reg.refused(exportsEnv.ask(A, { columns: ['id', 'nature', 'amount'] }));
    assert.deepEqual([err.status, err.code, err.message], [403, 'GOV_EXPORT_FIELD_FORBIDDEN', 'Este campo não pode ser exportado.']);
    assert.deepEqual(err.details.fields, ['nature']);
    assert.equal(await jobsCount(), before, 'nenhum pedido nem arquivo');
    const ok = await exportsEnv.askAndGenerate(A, { columns: ['id', 'amount'] });
    assert.equal(ok.job.status, 'READY', 'sem a coluna proibida o pedido segue');
    assert.equal((await viewOf(ok.out.exportJobId)).warnings.length, 0);
    const omitted = await exportsEnv.askAndGenerate(A, { columns: undefined });
    assert.deepEqual((await viewOf(omitted.out.exportJobId)).warnings, ['coluna nature omitida'], 'sem colunas no pedido a proibida sai com aviso');
  }, FIN);
});

test('m9d915 ALLOWED_MASKED exporta mascarado e a coluna RESTRICTED do catálogo continua mascarada', { skip: skip() }, async () => {
  await reg.withColumn(A, 'status', { classification: 'HIGH', masking: 'PARTIAL', exportability: 'ALLOWED_MASKED' }, async () => {
    const { job } = await exportsEnv.askAndGenerate(A, { columns: ['id', 'status', 'description'] });
    const lines = await csvOf(job);
    assert.ok(!lines.join('\n').includes('PENDING'), 'status ALLOWED_MASKED não sai em claro');
    assert.ok(lines[1].includes('****DING'), `status mascarado pelo registro: ${lines[1]}`);
    assert.ok(!lines.join('\n').includes('lançamento de teste'), 'a descrição (RESTRICTED no catálogo) sem view-restricted sai mascarada');
    assert.ok(lines[1].endsWith(';***'), `máscara total do catálogo (texto do parâmetro da exportação): ${lines[1]}`);
  }, FIN);
});

test('m9d915 WITH_APPROVAL passando no guard exporta em claro, sem fluxo humano', { skip: skip() }, async () => {
  const amount = await reg.rowOf(A, FIN.schema, FIN.table, 'amount');
  assert.equal(amount.exportability, 'WITH_APPROVAL', 'valor financeiro HIGH vem WITH_APPROVAL do registro');
  const { job } = await exportsEnv.askAndGenerate(A, { columns: ['id', 'amount'] });
  const lines = await csvOf(job);
  assert.deepEqual(lines.slice(1).map((line) => line.split(';')[1]).sort(), ['100.00', '101.00', '102.00'], 'valores em claro');
  // O "approved" é a decisão ALLOW do guard: sem ela, o mesmo registro mascara.
  const actor = { groupId: A.groupId, companyId: A.companyId, userId: A.userId, permissions: ['finance:read'] };
  const columns = financeEntries.columns.filter((c) => ['id', 'amount'].includes(c.key));
  const rows = [{ id: 'x', amount: '100' }];
  const notApproved = await maskExportRows(actor, financeEntries, columns, rows, { approved: false, maskText: '••••••' });
  assert.notEqual(notApproved.rows[0].amount, '100');
  assert.deepEqual(notApproved.maskedColumns, ['amount']);
  const approved = await maskExportRows(actor, financeEntries, columns, rows, { approved: true, maskText: '••••••' });
  assert.deepEqual([approved.rows[0].amount, approved.maskedColumns], ['100', []]);
  // Sem MFA o guard bloqueia e nada é gerado (a "aprovação" é só a decisão do guard).
  await exportsEnv.revokeMfa(A.userId);
  const blocked = await reg.refused(exportsEnv.ask(A, { columns: ['id', 'amount'] }));
  assert.equal(blocked.code, 'MFA_STEP_UP_REQUIRED');
});

test('m9d915 pedido cuja única coluna pedida é proibida é recusado, e coluna proibida some mesmo depois do pedido', { skip: skip() }, async () => {
  await reg.withColumn(A, 'nature', { exportability: 'FORBIDDEN' }, async () => {
    const err = await reg.refused(exportsEnv.ask(A, { columns: ['nature'] }));
    assert.equal(err.code, 'GOV_EXPORT_FIELD_FORBIDDEN');
  }, FIN);
  // O pedido foi aprovado com a coluna; antes de gerar o arquivo o steward a proíbe: o arquivo já sai sem ela.
  const out = await exportsEnv.ask(A, { columns: ['id', 'nature', 'amount'] });
  await reg.withColumn(A, 'nature', { exportability: 'FORBIDDEN' }, async () => {
    const { generateExport } = require('../../../src/features/core-governance/dlp/exports/export.run');
    const job = await generateExport(tenantRef, out.exportJobId);
    assert.ok(!(await csvOf(job))[0].includes('Natureza'));
  }, FIN);
});
