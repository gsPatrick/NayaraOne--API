'use strict';

// M9-D823 — links externos pelo serviço, com banco descartável: prazo dentro do teto, token só em hash, revogação imediata, máscara anônima, 404 único, MFA, transação das duas
// tabelas e o job de expiração.
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d823.servico.test.js"
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/shareEnv');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');
const { revokeShareLink, listShareLinks } = require('../../../src/features/core-governance/dlp/share/share.service');
const { accessPublicShare } = require('../../../src/features/core-governance/dlp/share/share.public');
const { runShareLinkExpiryJob } = require('../../../src/engines/jobs/shareLinkExpiryJob');
const policyService = require('../../../src/features/core-governance/dlp/policy.service');

let A;
let contract;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const ip = (() => { let n = 0; return () => `10.23.0.${(n += 1)}`; })();
const failure = (promise) => promise.then(() => null, (err) => ({ status: err.statusCode, code: err.code, message: err.message, details: err.details }));
const open = (token) => accessPublicShare({ token, ip: ip() });

before(async () => {
  if (!env.DISPOSABLE) return;
  A = (await env.loadTenants()).A;
  await env.cleanShares();
  contract = await env.makeContract(A);
});
afterEach(async () => { resolver.resetResolver(); if (env.DISPOSABLE) await env.cleanShares(); });
after(async () => { if (env.DISPOSABLE) await env.cleanShares(); await env.sequelize.close(); });
const withMfa = async () => env.grantMfa(A);

test('m9d823 o link expira no prazo pedido dentro do teto da política vigente', { skip: skip() }, async () => {
  await withMfa();
  const t0 = Date.now();
  const hours = (link) => (new Date(link.expiresAt).getTime() - t0) / 3600000;
  const standard = await env.share(A, contract);
  assert.ok(Math.abs(hours(standard.link) - 48) < 0.1, 'sem prazo pedido vale o teto da classe (HIGH: 48 h)');
  assert.equal(standard.link.status, 'ACTIVE');
  const short = await env.share(A, contract, { expiresInHours: 5 });
  assert.ok(Math.abs(hours(short.link) - 5) < 0.1, 'prazo menor que o teto vale como pedido');
  const job = await env.jobOf(short.link.exportJobId);
  assert.deepEqual([job.kind, job.action, job.status], ['SHARE', 'SHARE', 'APPROVED']);
  assert.ok(Math.abs((new Date(job.expires_at) - new Date(short.link.expiresAt))) < 1000, 'o pedido expira junto com o link');
  resolver.setResolver(async (_t, resources) => resources.map(() => 'RESTRICTED'));
  const restricted = await env.share(A, contract);
  assert.ok(Math.abs(hours(restricted.link) - 24) < 0.1, 'RESTRICTED: 24 h');
  await env.inBusinessTx(A, (tx) => policyService.updatePolicy(env.tenantOf(A), { userId: A.userId }, 'RESTRICTED', 'SHARE', { max_expiry_hours: 3 }, tx));
  const edited = await env.share(A, contract);
  assert.ok(Math.abs(hours(edited.link) - 3) < 0.1, 'o teto editado pelo administrador vale no link seguinte');
});

test('m9d823 prazo acima do teto recusado', { skip: skip() }, async () => {
  await withMfa();
  const err = await failure(env.share(A, contract, { expiresInHours: 100 }));
  assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_LINK_EXPIRY_TOO_LONG', 'O prazo máximo para esta classificação é de 48 horas.']);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.share_links')).rows[0].n, 0, 'nenhum link foi criado');
  const job = (await env.adminQuery("SELECT status, error_code FROM governance.export_jobs WHERE kind = 'SHARE'")).rows[0];
  assert.deepEqual([job.status, job.error_code], ['FAILED', 'GOV_LINK_EXPIRY_TOO_LONG'], 'o pedido fica registrado');
  const exactly = await env.share(A, contract, { expiresInHours: 48 });
  assert.equal(exactly.link.status, 'ACTIVE', 'no teto exato passa');
  const bad = await failure(env.share(A, contract, { expiresInHours: 0 }));
  assert.deepEqual([bad.status, bad.code], [400, 'GOV_LINK_REQUEST_INVALID']);
});

test('m9d823 token guardado apenas em hash', { skip: skip() }, async () => {
  await withMfa();
  const { link, token } = await env.share(A, contract);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 bytes em base64url');
  const row = await env.linkRow(link.id);
  const crypto = require('node:crypto');
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  const everything = JSON.stringify((await env.adminQuery('SELECT * FROM governance.share_links')).rows) + JSON.stringify((await env.adminQuery('SELECT * FROM governance.export_jobs')).rows)
    + JSON.stringify((await env.adminQuery("SELECT * FROM audit.audit_log WHERE entity_id = $1", [link.id])).rows);
  assert.equal(everything.includes(token), false, 'o token em claro não está em nenhuma tabela nem na auditoria');
  assert.equal(Object.keys(link).includes('token') || Object.keys(link).includes('tokenHash'), false, 'a visão do link não traz token');
  const listed = JSON.stringify(await env.inBusinessTx(A, (transaction) => listShareLinks({ tenant: env.tenantOf(A), actorUserId: A.userId, permissions: [], transaction })));
  assert.equal(listed.includes(token) || listed.includes(row.token_hash), false);
});

test('m9d823 acesso público mostra o recurso com campos HIGH e RESTRICTED mascarados', { skip: skip() }, async () => {
  await withMfa();
  const { token, link } = await env.share(A, contract);
  const { result } = await open(token);
  const data = result.data;
  assert.deepEqual([data.id, data.contractType, data.status], [contract.id, 'LEASE', contract.status], 'LOW em claro');
  assert.equal(data.contractNumber, contract.contractNumber, 'MEDIUM em claro');
  assert.equal(data.totalValue, '***', 'HIGH mascarado');
  assert.deepEqual(data.parties.map((p) => [p.role, p.name, p.taxId]), [['TENANT', '***', '***']], 'nome HIGH e CPF RESTRICTED mascarados, papel em claro');
  assert.equal(JSON.stringify(data).includes(contract.qaCpf) || JSON.stringify(data).includes('Maria QA-M9'), false);
  const audit = await env.auditOf('dlp.share.accessed', link.id);
  assert.equal(audit.length, 1, 'cada acesso é auditado');
  assert.equal(audit[0].after_json.resourceId, contract.id);
  assert.ok(audit[0].after_json.accessedAt);
  assert.equal((await env.linkRow(link.id)).access_count, 1);
});

test('m9d823 revogação vale no próximo acesso', { skip: skip() }, async () => {
  await withMfa();
  const { token, link } = await env.share(A, contract);
  assert.equal((await open(token)).result.link.id, link.id);
  const revoked = await env.inBusinessTx(A, (transaction) => revokeShareLink({ tenant: env.tenantOf(A), actorUserId: A.userId, permissions: [], id: link.id, transaction }));
  assert.equal(revoked.status, 'REVOKED');
  const err = await failure(open(token));
  assert.deepEqual([err.status, err.code, err.message], [404, 'GOV_LINK_UNAVAILABLE', 'Link indisponível.']);
  assert.equal((await env.auditOf('dlp.share.revoked', link.id)).length, 1);
  const again = await failure(env.inBusinessTx(A, (transaction) => revokeShareLink({ tenant: env.tenantOf(A), actorUserId: A.userId, permissions: [], id: link.id, transaction })));
  assert.deepEqual([again.status, again.code, again.message], [409, 'GOV_LINK_ALREADY_FINAL', 'Este link já foi encerrado.']);
  const other = await env.share(A, contract);
  const strangerId = await env.otherUserId();
  const stranger = await failure(env.inBusinessTx(A, (transaction) => revokeShareLink({ tenant: env.tenantOf(A), actorUserId: strangerId, permissions: [], id: other.link.id, transaction })));
  assert.deepEqual([stranger.status, stranger.code, stranger.message], [403, 'GOV_LINK_NOT_OWNER', 'Você não pode revogar este link.']);
  const admin = await env.inBusinessTx(A, (transaction) => revokeShareLink({ tenant: env.tenantOf(A), actorUserId: strangerId, permissions: ['governance:dlp:admin'], id: other.link.id, transaction }));
  assert.equal(admin.status, 'REVOKED', 'governance:dlp:admin revoga link de outra pessoa');
});

test('m9d823 404 igual para inexistente, revogado, expirado e adulterado', { skip: skip() }, async () => {
  await withMfa();
  const { token, link } = await env.share(A, contract);
  await env.adminQuery("UPDATE governance.share_links SET status = 'REVOKED', revoked_at = now() WHERE id = $1", [link.id]);
  const second = await env.share(A, contract);
  await env.adminQuery("UPDATE governance.share_links SET expires_at = now() - interval '1 second' WHERE id = $1", [second.link.id]);
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  const bodies = [];
  for (const candidate of [token, second.token, tampered, 'x'.repeat(43), 'curto', '../../etc/passwd']) {
    const err = await failure(open(candidate));
    bodies.push(JSON.stringify([err.status, err.code, err.message, err.details]));
  }
  assert.equal(new Set(bodies).size, 1, 'a resposta é idêntica nos seis casos');
  assert.match(bodies[0], /404.*GOV_LINK_UNAVAILABLE.*Link indisponível/);
  assert.equal((await env.linkRow(second.link.id)).status, 'ACTIVE', 'o acesso recusa pelo relógio sem esperar o job');
});

test('m9d823 RESTRICTED sem MFA bloqueia e HIGH sem justificativa também', { skip: skip() }, async () => {
  resolver.setResolver(async (_t, resources) => resources.map(() => 'RESTRICTED'));
  await env.revokeMfa(A.userId);
  const noMfa = await failure(env.share(A, contract));
  assert.deepEqual([noMfa.status, noMfa.code, noMfa.message], [403, 'MFA_STEP_UP_REQUIRED', 'Confirme o código de verificação para continuar.']);
  const job = (await env.adminQuery("SELECT status, block_reason, classification FROM governance.export_jobs WHERE kind = 'SHARE'")).rows[0];
  assert.deepEqual([job.status, job.block_reason, job.classification], ['BLOCKED', 'MFA', 'RESTRICTED']);
  resolver.resetResolver();
  await withMfa();
  const noWhy = await failure(env.share(A, contract, { justification: 'curta' }));
  assert.deepEqual([noWhy.status, noWhy.code], [422, 'GOV_DLP_PURPOSE_REQUIRED']);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.share_links')).rows[0].n, 0);
});

test('m9d823 revogar muda share_links e export_jobs na mesma transação', { skip: skip() }, async () => {
  await withMfa();
  const { link } = await env.share(A, contract);
  const boom = new Error('falha depois de revogar');
  const failed = await failure(env.inBusinessTx(A, async (transaction) => {
    await revokeShareLink({ tenant: env.tenantOf(A), actorUserId: A.userId, permissions: [], id: link.id, transaction });
    throw boom;
  }));
  assert.equal(failed.message, boom.message);
  assert.equal((await env.linkRow(link.id)).status, 'ACTIVE', 'a transação desfeita não deixa meia revogação em share_links');
  assert.equal((await env.jobOf(link.exportJobId)).status, 'APPROVED', 'nem em export_jobs');
  await env.inBusinessTx(A, (transaction) => revokeShareLink({ tenant: env.tenantOf(A), actorUserId: A.userId, permissions: [], id: link.id, transaction }));
  const row = await env.linkRow(link.id);
  assert.deepEqual([row.status, row.revoked_by, Boolean(row.revoked_at)], ['REVOKED', A.userId, true]);
  assert.equal((await env.jobOf(link.exportJobId)).status, 'REVOKED');
});

test('m9d823 shareLinkExpiryJob marca EXPIRED nos dois', { skip: skip() }, async () => {
  await withMfa();
  const due = await env.share(A, contract);
  const fresh = await env.share(A, contract);
  await env.adminQuery("UPDATE governance.share_links SET expires_at = now() - interval '1 minute' WHERE id = $1", [due.link.id]);
  await runShareLinkExpiryJob(new Date(), { force: true });
  assert.equal((await env.linkRow(due.link.id)).status, 'EXPIRED');
  assert.equal((await env.jobOf(due.link.exportJobId)).status, 'EXPIRED');
  assert.equal((await env.linkRow(fresh.link.id)).status, 'ACTIVE');
  assert.equal((await env.jobOf(fresh.link.exportJobId)).status, 'APPROVED');
  const revoked = await failure(env.inBusinessTx(A, (transaction) => revokeShareLink({ tenant: env.tenantOf(A), actorUserId: A.userId, permissions: [], id: due.link.id, transaction })));
  assert.equal(revoked.code, 'GOV_LINK_ALREADY_FINAL', 'estado final não volta');
});

test('m9d823 mesma Idempotency-Key devolve o mesmo link sem repetir o token e outro corpo é 409', { skip: skip() }, async () => {
  await withMfa();
  const key = env.nextKey('idem');
  const first = await env.share(A, contract, {}, { key });
  const second = await env.share(A, contract, {}, { key });
  assert.deepEqual([second.link.id === first.link.id, second.token, second.replayed], [true, null, true]);
  const clash = await failure(env.share(A, contract, { recipientLabel: 'Outro destinatário' }, { key }));
  assert.deepEqual([clash.status, clash.code], [409, 'GOV_DLP_IDEMPOTENCY_CONFLICT']);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.share_links')).rows[0].n, 1);
});
