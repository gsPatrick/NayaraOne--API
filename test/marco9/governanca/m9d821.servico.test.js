'use strict';

// M9-D821 — decide() com banco: export_job sempre gravado, evento, idempotência, durabilidade, isolamento e kind. Cada decisão confirma sua própria transação; os testes
// limpam o que criaram. Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d821.servico.test.js"
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/dlpEnv');
const { request, LONG } = require('../_helpers/dlpGuardKit');
const guardService = require('../../../src/features/core-governance/dlp/guard.service');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');
const suspension = require('../../../src/features/core-governance/dlp/suspension.reader');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => { resolver.resetResolver(); suspension.resetReader(); if (env.DISPOSABLE) await env.cleanJobs(); });
after(async () => { await env.sequelize.close(); });
const decide = (tenant, over = {}) => guardService.decide(tenant, request({ actorUserId: tenant.userId, ...over }));
const classes = (map) => resolver.setResolver(async (_t, resources) => resources.map((r) => map[r.id] || 'LOW'));

test('m9d821 o resolvedor stub devolve HIGH sem registro de classificação', { skip: skip() }, async () => {
  const out = await decide(tenants.A, { resourceIds: ['a', 'b'] });
  assert.equal(out.classification, 'HIGH');
  assert.equal(out.job.classification, 'HIGH');
  assert.equal(out.decision, 'ALLOW', 'HIGH com tudo certo, 6.000 linhas');
  assert.equal(out.job.status, 'APPROVED');
});

test('m9d821 pedido aprovado gera export_job APPROVED com decision_trace completo', { skip: skip() }, async () => {
  const out = await decide(tenants.A, { resourceIds: ['r1'], idempotencyKey: 'k-aprovado' });
  const row = await env.jobRow(out.job.id);
  assert.deepEqual([row.status, row.kind, row.action, row.classification, row.purpose, row.estimated_rows, row.block_reason], ['APPROVED', 'EXPORT', 'EXPORT', 'HIGH', 'CONTABIL', 6000, null]);
  assert.equal(row.justification, LONG);
  assert.deepEqual(row.decision_trace.map((t) => t.step), ['CLASSIFICATION', 'PERMISSION', 'PURPOSE', 'MFA', 'VOLUME', 'DECISION']);
  assert.equal(row.decision_trace.at(-1).result, 'ALLOW');
  assert.equal(row.actor_user_id, tenants.A.userId);
  assert.ok(row.expires_at && new Date(row.expires_at) > new Date(Date.now() + 47 * 3600 * 1000), 'expira em 48 h');
  assert.equal(row.obligations.maxExpiryHours, 48);
  assert.equal((await env.outboxOf(row.id)).length, 0, 'aprovado não publica dlp.export.blocked');
});

test('m9d821 bloqueio grava export_job BLOCKED', { skip: skip() }, async () => {
  const out = await decide(tenants.A, { mfaOk: false });
  assert.deepEqual([out.decision, out.blockReason, out.errorCode], ['DENY', 'MFA', 'MFA_STEP_UP_REQUIRED']);
  const row = await env.jobRow(out.job.id);
  assert.deepEqual([row.status, row.block_reason, row.classification], ['BLOCKED', 'MFA', 'HIGH']);
  assert.equal(row.decision_trace.find((t) => t.step === 'MFA').result, 'FAIL');
  assert.equal(row.decision_trace.find((t) => t.step === 'VOLUME').result, 'SKIPPED');
  const volume = await decide(tenants.A, { estimatedRows: 12000 });
  assert.deepEqual([volume.job.status, volume.job.blockReason], ['BLOCKED', 'VOLUME']);
  const [audit] = await env.adminQuery("SELECT before_json FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.dlp.export.blocked' ORDER BY occurred_at DESC LIMIT 1", [tenants.A.companyId]).then((r) => r.rows);
  assert.equal(audit.before_json.blockReason, 'VOLUME', 'o bloqueio é auditado');
});

test('m9d821 bloqueio publica dlp.export.blocked uma vez', { skip: skip() }, async () => {
  const out = await decide(tenants.A, { mfaOk: false, idempotencyKey: 'k-evento' });
  const events = await env.outboxOf(out.job.id);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload_json, { exportJobId: out.job.id, actor: tenants.A.userId, classification: 'HIGH', blockReason: 'MFA' });
  assert.equal(events[0].company_id, tenants.A.companyId);
  const again = await decide(tenants.A, { mfaOk: false, idempotencyKey: 'k-evento' });
  assert.equal(again.job.id, out.job.id);
  assert.equal((await env.outboxOf(out.job.id)).length, 1, 'repetir o pedido não publica de novo');
});

test('m9d821 classificação mais alta do pedido prevalece', { skip: skip() }, async () => {
  classes({ baixo: 'LOW', medio: 'MEDIUM', restrito: 'RESTRICTED' });
  const mixed = await decide(tenants.A, { resourceIds: ['baixo', 'medio', 'restrito'], estimatedRows: 800, mfaOk: true });
  assert.equal(mixed.classification, 'RESTRICTED');
  assert.equal(mixed.obligations.maxExpiryHours, 24, 'a política é a da classe mais alta');
  const tooMany = await decide(tenants.A, { resourceIds: ['baixo', 'restrito'], estimatedRows: 1001 });
  assert.deepEqual([tooMany.job.blockReason, tooMany.classification], ['VOLUME', 'RESTRICTED']);
  const low = await decide(tenants.A, { resourceIds: ['baixo'], estimatedRows: 100000, justification: '', purpose: undefined, mfaOk: false });
  assert.deepEqual([low.decision, low.classification], ['ALLOW', 'LOW']);
});

test('m9d821 mesma Idempotency-Key devolve o mesmo job', { skip: skip() }, async () => {
  const first = await decide(tenants.A, { idempotencyKey: 'k-igual' });
  const second = await decide(tenants.A, { idempotencyKey: 'k-igual' });
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.decision, first.decision);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.export_jobs WHERE idempotency_key = $1', ['k-igual'])).rows[0].n, 1);
  const other = await env.codeOf(decide(tenants.A, { idempotencyKey: 'k-igual', estimatedRows: 10 }));
  assert.deepEqual([other.status, other.code], [409, 'GOV_DLP_IDEMPOTENCY_CONFLICT'], 'a mesma chave com outro corpo é recusada');
  const semChave = await Promise.all([decide(tenants.A), decide(tenants.A)]);
  assert.notEqual(semChave[0].job.id, semChave[1].job.id, 'sem chave, cada pedido é um job');
  const paralelos = await Promise.all([1, 2, 3, 4].map(() => decide(tenants.A, { idempotencyKey: 'k-corrida' })));
  assert.equal(new Set(paralelos.map((p) => p.job.id)).size, 1, 'pedidos simultâneos com a mesma chave caem no mesmo job');
});

test('m9d821 bloqueio não é desfeito por rollback do negócio', { skip: skip() }, async () => {
  let blockedId;
  await env.withRollbackTenantTransaction(tenants.A, async () => {
    const out = await decide(tenants.A, { mfaOk: false });
    blockedId = out.job.id;
    assert.equal(out.job.status, 'BLOCKED');
  });
  const row = await env.jobRow(blockedId);
  assert.equal(row.status, 'BLOCKED', 'o job sobrevive ao rollback da transação de negócio');
  assert.equal((await env.outboxOf(blockedId)).length, 1, 'o evento também');
});

test('m9d821 erro no meio da decisão deixa o job FAILED e relança o erro', { skip: skip() }, async () => {
  resolver.setResolver(async () => { throw new Error('registro de classificação fora do ar'); });
  const err = await env.codeOf(decide(tenants.A, { idempotencyKey: 'k-falha' }));
  assert.ok(err, 'o erro sobe');
  const rows = (await env.adminQuery("SELECT status, block_reason, decision_trace FROM governance.export_jobs WHERE idempotency_key = 'k-falha'")).rows;
  assert.equal(rows.length, 1, 'o job não some');
  assert.equal(rows[0].status, 'FAILED');
  assert.match(JSON.stringify(rows[0].decision_trace), /registro de classificação fora do ar/);
});

test('m9d821 isolamento entre empresas', { skip: skip() }, async () => {
  const a = await decide(tenants.A, { idempotencyKey: 'k-iso' });
  const b = await decide(tenants.B, { idempotencyKey: 'k-iso' });
  assert.notEqual(a.job.id, b.job.id, 'a mesma chave em outra empresa é outro job');
  await env.withRollbackTenantTransaction(tenants.B, async (tx) => {
    const seen = await env.rows('SELECT id, company_id FROM governance.export_jobs', {}, tx);
    assert.deepEqual(seen.map((r) => r.id), [b.job.id], 'a sessão de B só enxerga o pedido de B');
  });
  const get = await guardService.getJob(tenants.B, a.job.id);
  assert.equal(get, null, 'o pedido de A não existe para B');
});

test('m9d821 export_job guarda kind EXPORT, SHARE, PRINT ou DOWNLOAD e recusa outro valor', { skip: skip() }, async () => {
  for (const [action, kind] of [['EXPORT', 'EXPORT'], ['SHARE', 'SHARE'], ['PRINT', 'PRINT'], ['EXPORT', 'DOWNLOAD'], ['PRINT', 'DOWNLOAD']]) {
    const out = await decide(tenants.A, { action, kind, mfaOk: true });
    assert.equal((await env.jobRow(out.job.id)).kind, kind, `${action}/${kind}`);
  }
  const defaulted = await decide(tenants.A, { action: 'SHARE', kind: undefined });
  assert.equal(defaulted.job.kind, 'SHARE', 'sem kind, vale a ação');
  const bad = await env.codeOf(decide(tenants.A, { kind: 'UPLOAD' }));
  assert.deepEqual([bad.status, bad.code], [400, 'GOV_DLP_REQUEST_INVALID']);
  const mismatch = await env.codeOf(decide(tenants.A, { action: 'SHARE', kind: 'PRINT' }));
  assert.equal(mismatch.code, 'GOV_DLP_REQUEST_INVALID', 'SHARE só tem kind SHARE');
  await assert.rejects(env.adminQuery("UPDATE governance.export_jobs SET kind = 'UPLOAD' WHERE company_id = $1", [tenants.A.companyId]), /gov_expjob_kind_chk/, 'o banco também recusa');
});

test('m9d821 VIEW e COPY percorrem só as etapas 1, 2, 4 e 6 e não criam export_job', { skip: skip() }, async () => {
  classes({ pessoa: 'HIGH' });
  const before = (await env.adminQuery('SELECT count(*)::int AS n FROM governance.export_jobs')).rows[0].n;
  const view = await guardService.decide(tenants.A, { actorUserId: tenants.A.userId, action: 'VIEW', resourceType: 'people.persons', resourceIds: ['pessoa'], mfaOk: false, permissions: [] });
  assert.deepEqual([view.decision, view.mode, view.job], ['ALLOW', 'LIGHT', null]);
  assert.equal(view.trace.find((t) => t.step === 'PURPOSE').result, 'NOT_APPLICABLE');
  const copy = await guardService.decide(tenants.A, { actorUserId: tenants.A.userId, action: 'COPY', resourceType: 'people.persons', resourceIds: ['pessoa'], mfaOk: false, permissions: [] });
  assert.equal(copy.decision, 'ALLOW');
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.export_jobs')).rows[0].n, before, 'nenhum pedido criado');
  assert.ok((await env.adminQuery("SELECT 1 FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.dlp.view'", [tenants.A.companyId])).rows.length >= 1, 'HIGH/VIEW exige auditoria');
  classes({ restrito: 'RESTRICTED' });
  const restricted = await guardService.decide(tenants.A, { actorUserId: tenants.A.userId, action: 'COPY', resourceType: 'people.persons', resourceIds: ['restrito'], permissions: [] });
  assert.deepEqual([restricted.decision, restricted.blockReason, restricted.job], ['DENY', 'POLICY', null]);
  const seen = [];
  const { setSignalSink, resetSignalSink } = require('../../../src/features/core-governance/dlp/signals.sink');
  setSignalSink(async (_tenant, signal) => { seen.push(signal); });
  try {
    await guardService.decide(tenants.A, { actorUserId: tenants.A.userId, action: 'VIEW', resourceType: 'people.persons', resourceIds: ['restrito'], permissions: [] });
  } finally { resetSignalSink(); }
  assert.deepEqual([seen.length, seen[0].action, seen[0].classification, seen[0].decision], [1, 'VIEW', 'RESTRICTED', 'DENY'], 'o access_signal (M9-D824) recebe cada decisão leve');
});

test('m9d821 usuário suspenso por anomalia é bloqueado em EXPORT e liberado em VIEW com SUSPENDED', { skip: skip() }, async () => {
  suspension.setReader(async (_tenant, userId) => (userId === tenants.A.userId ? new Date(Date.now() + 3600 * 1000) : null));
  classes({ x: 'LOW' });
  const exp = await decide(tenants.A, { resourceIds: ['x'], action: 'EXPORT' });
  assert.deepEqual([exp.decision, exp.blockReason, exp.errorCode, exp.job.status], ['DENY', 'SUSPENDED', 'GOV_DLP_USER_SUSPENDED', 'BLOCKED']);
  assert.equal((await env.outboxOf(exp.job.id)).length, 1, 'bloqueio por suspensão também publica o evento');
  const view = await guardService.decide(tenants.A, { actorUserId: tenants.A.userId, action: 'VIEW', resourceType: 'x', resourceIds: ['x'], permissions: [] });
  assert.equal(view.decision, 'ALLOW');
  const other = await decide(tenants.B, { resourceIds: ['x'] });
  assert.equal(other.decision, 'ALLOW', 'outro usuário não é afetado');
});

test('m9d821 pedido sem ação válida ou sem tipo de recurso é recusado antes de gravar', { skip: skip() }, async () => {
  for (const over of [{ action: 'DELETE' }, { resourceType: '' }, { estimatedRows: -1 }, { estimatedRows: 'muitos' }, { estimatedRows: undefined }]) {
    const err = await env.codeOf(decide(tenants.A, over));
    assert.deepEqual([err.status, err.code], [400, 'GOV_DLP_REQUEST_INVALID'], JSON.stringify(over));
  }
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.export_jobs')).rows[0].n, 0);
});
