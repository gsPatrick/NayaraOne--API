'use strict';

// M9-D822 — POST /exports pelo serviço, com banco descartável: bloqueios do guard, expiração no teto da política, job de expiração, idempotência, posse e estados do download.
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d822.servico.test.js"
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/exportsEnv');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');
const { generateExport } = require('../../../src/features/core-governance/dlp/exports/export.run');
const { downloadExport } = require('../../../src/features/core-governance/dlp/exports/export.download');
const { getExport } = require('../../../src/features/core-governance/dlp/exports/export.read');
const { expireCompany, removeFromDisk } = require('../../../src/features/core-governance/dlp/exports/export.expiry');
const { signDownloadUrl } = require('../../../src/features/core-governance/dlp/exports/export.url');
const policyService = require('../../../src/features/core-governance/dlp/policy.service');

env.useMonth(env.uniqueMonth());
let A;
let tenantRef;
let restore;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => {
  if (!env.DISPOSABLE) return;
  A = (await env.loadTenants()).A;
  tenantRef = { groupId: A.groupId, companyId: A.companyId };
  restore = await env.withRolePermissions({ 'CI GESTOR': { 'finance:read': true, 'governance:dlp:export': true }, 'CI MAKER': { 'finance:read': true, 'governance:dlp:export': true } });
  await env.cleanExports();
  await env.seedEntries(A, 3);
});
afterEach(async () => { resolver.resetResolver(); if (env.DISPOSABLE) await env.cleanExports(); });
after(async () => {
  if (env.DISPOSABLE) {
    await env.cleanExports();
    await restore();
  }
  await env.sequelize.close();
});
const failure = (promise) => promise.then(() => null, (err) => ({ status: err.statusCode, code: err.code, message: err.message }));
const url = (job, userId) => { const u = new URL(signDownloadUrl({ jobId: job.id, userId, now: new Date(), urlMinutes: 15, fileExpiresAt: job.expiresAt }).url, 'http://x'); return { exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') }; };
const dl = (job, extra = {}) => downloadExport({ tenant: tenantRef, actorUserId: A.userId, permissions: [], id: job.id, ...url(job, job.actorUserId), ...extra });

test('m9d822 export RESTRICTED sem MFA bloqueia', { skip: skip() }, async () => {
  resolver.setResolver(async (_t, resources) => resources.map(() => 'RESTRICTED'));
  const err = await failure(env.ask(A));
  assert.deepEqual([err.status, err.code, err.message], [403, 'MFA_STEP_UP_REQUIRED', 'Confirme o código de verificação para continuar.']);
  const { rows } = await env.adminQuery("SELECT status, block_reason, format, classification FROM governance.export_jobs WHERE company_id = $1", [A.companyId]);
  assert.deepEqual(rows.map((r) => [r.status, r.block_reason, r.format, r.classification]), [['BLOCKED', 'MFA', 'CSV', 'RESTRICTED']], 'o pedido fica registrado como BLOCKED e nada é gerado');
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM people.files WHERE storage_key LIKE $1', ['dlp-exports/%'])).rows[0].n, 0);
});

test('m9d822 export HIGH sem justificativa bloqueia', { skip: skip() }, async () => {
  await env.grantMfa(A);
  for (const over of [{ justification: undefined }, { justification: 'curta demais' }, { purpose: 'INVENTADA' }]) {
    const err = await failure(env.ask(A, over));
    assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_DLP_PURPOSE_REQUIRED', 'Informe a finalidade e uma justificativa com pelo menos 20 caracteres.']);
  }
});

test('m9d822 o arquivo expira no teto da política vigente da classe (valores em M9-D820)', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const t0 = Date.now();
  const high = await env.ask(A);
  const hours = (id) => env.jobOf(id).then((row) => (new Date(row.expires_at).getTime() - t0) / 3600000);
  assert.ok(Math.abs((await hours(high.exportJobId)) - 48) < 0.1, 'HIGH expira em 48 h');
  resolver.setResolver(async (_t, resources) => resources.map(() => 'RESTRICTED'));
  const restricted = await env.ask(A);
  assert.ok(Math.abs((await hours(restricted.exportJobId)) - 24) < 0.1, 'RESTRICTED expira em 24 h');
  await env.inBusinessTx(A, (tx) => policyService.updatePolicy(tenantRef, { userId: A.userId }, 'RESTRICTED', 'EXPORT', { max_expiry_hours: 6 }, tx));
  const edited = await env.ask(A);
  assert.ok(Math.abs((await hours(edited.exportJobId)) - 6) < 0.1, 'o teto editado pelo administrador vale no pedido seguinte');
});

test('m9d822 job de expiração apaga o arquivo e mantém o hash', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const { job } = await env.askAndGenerate(A);
  assert.equal(job.status, 'READY');
  const before = await env.fileRow(job.fileId);
  assert.ok(before && env.onDisk(before.storageKey), 'o arquivo existe em disco e em people.files');
  await env.adminQuery("UPDATE governance.export_jobs SET expires_at = now() - interval '1 minute' WHERE id = $1", [job.id]);
  const summary = await env.inBusinessTx(A, (tx) => expireCompany(tenantRef, tx));
  removeFromDisk(summary.storageKeys);
  assert.equal(summary.expired, 1);
  const row = await env.jobOf(job.id);
  assert.deepEqual([row.status, row.file_id, row.file_sha256 === job.fileSha256, Boolean(row.expired_at)], ['EXPIRED', null, true, true]);
  assert.equal(await env.fileRow(job.fileId), null, 'o registro do arquivo saiu');
  assert.equal(env.onDisk(before.storageKey), false, 'o arquivo físico foi apagado');
  const err = await failure(dl(job));
  assert.deepEqual([err.status, err.code, err.message], [410, 'GOV_EXPORT_EXPIRED', 'O arquivo expirou. Faça uma nova solicitação.']);
  assert.equal((await env.auditOf('dlp.export.expired', job.id)).length, 1);
});

test('m9d822 recurso, coluna e formato inválidos devolvem 400 e job inexistente 404', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const cases = [
    [{ resourceType: 'nao.existe' }, 'GOV_EXPORT_RESOURCE_INVALID', 'Tipo de exportação inválido.'],
    [{ resourceType: 'legal.contract_pdf' }, 'GOV_EXPORT_RESOURCE_INVALID', 'Tipo de exportação inválido.'],
    [{ columns: ['id', 'cpf'] }, 'GOV_EXPORT_COLUMN_INVALID', 'Coluna inválida para esta exportação.'],
    [{ format: 'DOCX' }, 'GOV_EXPORT_FORMAT_INVALID', 'Formato inválido.'],
    [{ format: undefined }, 'GOV_EXPORT_FORMAT_INVALID', 'Formato inválido.'],
    [{ filter: { competenceMonth: 'janeiro' } }, 'GOV_EXPORT_FILTER_INVALID', 'Filtro inválido para esta exportação.'],
  ];
  for (const [over, code, message] of cases) {
    const err = await failure(env.ask(A, over));
    assert.deepEqual([err.status, err.code, err.message], [400, code, message], JSON.stringify(over));
  }
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.export_jobs WHERE company_id = $1', [A.companyId])).rows[0].n, 0, 'pedido inválido não grava nada');
  const missing = await failure(env.inBusinessTx(A, (transaction) => getExport({ tenant: tenantRef, actorUserId: A.userId, permissions: [], id: '00000000-0000-4000-8000-000000000000', transaction })));
  assert.deepEqual([missing.status, missing.code, missing.message], [404, 'GOV_NOT_FOUND', 'Registro não encontrado.']);
});

test('m9d822 mesma Idempotency-Key não gera dois arquivos', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const key = env.nextKey('idem');
  const first = await env.ask(A, {}, { key });
  const second = await env.ask(A, {}, { key });
  assert.equal(second.exportJobId, first.exportJobId);
  assert.equal(second.replayed, true);
  await generateExport(tenantRef, first.exportJobId);
  const again = await generateExport(tenantRef, first.exportJobId);
  assert.equal(again, null, 'o pedido já foi levado: ninguém gera de novo');
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.export_jobs WHERE company_id = $1 AND idempotency_key LIKE $2', [A.companyId, '%:' + key])).rows[0].n, 1);
  assert.equal((await env.adminQuery("SELECT count(*)::int AS n FROM people.files WHERE company_id = $1 AND storage_key LIKE 'dlp-exports/%'", [A.companyId])).rows[0].n >= 1, true);
  const files = await env.adminQuery('SELECT file_id FROM governance.export_jobs WHERE id = $1', [first.exportJobId]);
  assert.ok(files.rows[0].file_id, 'um arquivo para a chave');
  const conflict = await failure(env.ask(A, { format: 'PDF' }, { key }));
  assert.deepEqual([conflict.status, conflict.code], [409, 'GOV_DLP_IDEMPOTENCY_CONFLICT'], 'mesma chave com outro corpo');
});

test('m9d822 download por outra pessoa recusado', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const { job } = await env.askAndGenerate(A);
  const other = await env.otherUserId();
  const err = await failure(dl(job, { actorUserId: other }));
  assert.deepEqual([err.status, err.code, err.message], [403, 'GOV_EXPORT_NOT_OWNER', 'Este arquivo foi gerado para outra pessoa.']);
  const admin = await dl(job, { actorUserId: other, permissions: ['governance:dlp:admin'] });
  assert.ok(admin.buffer.length > 10, 'governance:dlp:admin baixa');
  const mine = await dl(job);
  assert.equal(mine.sha256, job.fileSha256);
  const audit = await env.auditOf('dlp.export.downloaded', job.id);
  assert.equal(audit.length, 2, 'cada download é auditado');
});

test('m9d822 download com job GENERATING devolve 409', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const out = await env.ask(A);
  const job = await env.jobOf(out.exportJobId);
  const fake = { id: job.id, actorUserId: A.userId, expiresAt: job.expires_at };
  const approved = await failure(dl(fake));
  assert.deepEqual([approved.status, approved.code, approved.message], [409, 'GOV_EXPORT_NOT_READY', 'O arquivo ainda está sendo gerado.']);
  await env.adminQuery("UPDATE governance.export_jobs SET status = 'GENERATING' WHERE id = $1", [job.id]);
  const generating = await failure(dl(fake));
  assert.deepEqual([generating.status, generating.code], [409, 'GOV_EXPORT_NOT_READY']);
  await env.adminQuery("UPDATE governance.export_jobs SET status = 'APPROVED' WHERE id = $1", [job.id]);
  const done = await generateExport(tenantRef, job.id);
  assert.equal(done.status, 'READY');
  const noSig = await failure(downloadExport({ tenant: tenantRef, actorUserId: A.userId, permissions: [], id: job.id, exp: '1', sig: 'x' }));
  assert.deepEqual([noSig.status, noSig.code], [403, 'GOV_EXPORT_LINK_INVALID'], 'o endereço assinado é exigido além do login');
});

test('m9d822 coluna RESTRICTED sai mascarada sem governance:dlp:view-restricted e em claro com ela', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const { job } = await env.askAndGenerate(A, { columns: ['id', 'amount', 'description'] });
  const { buffer } = await dl(job);
  const text = buffer.toString('utf8');
  assert.match(text, /\*\*\*/, 'descrição mascarada');
  assert.doesNotMatch(text, /lançamento de teste/);
  const back = await env.withRolePermissions({ 'CI GESTOR': { 'governance:dlp:view-restricted': true } });
  try {
    const { job: open } = await env.askAndGenerate(A, { columns: ['id', 'description'] });
    assert.match((await dl(open)).buffer.toString('utf8'), /lançamento de teste/);
  } finally { await back(); }
});
