'use strict';

// M9-D701 (BI-014, §20 e §21) — POST /analytics/exports pela rota real: 202 com o job na fila, risco pelo volume, MFA no alto risco, permissão, escopo,
// métrica degradada e filtros congelados. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d701Env');
const { requestExport } = require('../../../src/features/analytics/exports');
const { updateExportJobState } = require('../../../src/features/analytics/exportJobStore.service');

let env;
let metric;
before(async () => {
  env = await e.setup();
  metric = await e.metricWithSeries(env, { series: 5 });
});
after(() => e.teardown(env));

const body = (extra = {}) => ({ target: { metricCode: metric.code }, period: e.TODAY, ...extra });
const post = (b, opts = {}) => env.http('POST', '/analytics/exports', { body: b, ...opts });
const code = (res) => res.body && res.body.error && res.body.error.code;

test('m9d701 export pequeno é LOW, sem MFA, e devolve 202 com o job na fila', async () => {
  const res = await post(body());
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual([res.body.data.status, res.body.data.riskLevel], ['QUEUED', 'LOW']);
  const job = await e.jobRow(env, res.body.data.jobId);
  assert.deepEqual([job.status, job.requested_by, job.metric_code, job.mfa_step_up_id], ['QUEUED', env.A.userId, metric.code, null]);
  assert.equal(job.scope.kind, 'METRIC');
  assert.equal(job.scope.estimatedRows, 6, 'o valor principal e as 5 séries');
  assert.equal(res.headers.get('cache-control'), 'no-store, private');
});

test('m9d701 export massivo exige MFA e gera auditoria', async () => {
  await e.setParam(env, 'analytics.export.limite_linhas_alto_risco', 3);
  // sem MFA recente: o serviço recusa (sem forçar o fluxo de MFA por HTTP)
  const ctx = { groupId: env.A.groupId, companyId: env.A.companyId, actorUserId: env.A.userId, permissions: e.PERMS };
  await assert.rejects(() => e.inTx(env.A, { commit: true }, (tx) => requestExport(ctx, body(), {}, tx)), (err) => {
    assert.equal(err.statusCode, 403);
    assert.ok(['MFA_REQUIRED_NOT_ENABLED', 'MFA_STEP_UP_REQUIRED'].includes(err.code), err.code);
    return true;
  });
  await e.enableMfa(env, env.A, env.A.userId);
  await e.expireMfa(env, env.A.userId);
  await assert.rejects(() => e.inTx(env.A, { commit: true }, (tx) => requestExport(ctx, body(), {}, tx)), (err) => {
    assert.equal(err.code, 'MFA_STEP_UP_REQUIRED');
    assert.equal(err.message, 'Confirmação por MFA necessária para esta exportação.');
    return true;
  });
  const none = (await env.admin.query("SELECT count(*)::int AS n FROM analytics.export_jobs WHERE metric_code = :m AND risk_level = 'HIGH'", { replacements: { m: metric.code } }))[0][0].n;
  assert.equal(none, 0, 'a recusa não deixa job nenhum');
  await env.admin.query("UPDATE core.mfa_step_ups SET expires_at = now() + interval '10 minutes' WHERE user_id = :u", { replacements: { u: env.A.userId } });
  const res = await post(body());
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(res.body.data.riskLevel, 'HIGH');
  const job = await e.jobRow(env, res.body.data.jobId);
  assert.ok(job.mfa_step_up_id, 'o job guarda o step-up que o liberou');
  const audit = (await e.auditRows(env, job.id)).map((a) => a.action);
  assert.deepEqual(audit, ['analytics.export.request', 'analytics.export.mfa_approved']);
  const log = await e.accessRows(env, job.id);
  assert.deepEqual(log.map((l) => [l.action, l.rows_returned]), [['EXPORT_REQUEST', 6]]);
  assert.match(log[0].ip_hash || '', /^[0-9a-f]{64}$/);
  assert.deepEqual(await e.eventTypes(env, job.id), ['analytics.export.requested']);
  await e.setParam(env, 'analytics.export.limite_linhas_alto_risco', 1000);
});

test('m9d701 sem a permissão analytics:export a rota recusa com a mensagem do livro', async () => {
  const res = await post(body(), { perms: ['analytics:read', 'finance:read'] });
  assert.equal(res.status, 403);
  assert.equal(code(res), 'PERMISSION_DENIED');
  assert.equal(res.body.error.message, 'Permissão ausente: analytics:export.');
  const noDomain = await post(body(), { perms: ['analytics:read', 'analytics:export'] });
  assert.equal(noDomain.status, 403, 'falta a permissão do domínio (finance:read)');
  assert.equal(noDomain.body.error.message, 'Permissão ausente: finance:read.');
});

test('m9d701 empresa de outro grupo ou sem vínculo é 404 ANALYTICS_SCOPE_NOT_FOUND', async () => {
  const outra = await post(body({ companyId: env.B.companyId }));
  assert.equal(outra.status, 404);
  assert.equal(code(outra), 'ANALYTICS_SCOPE_NOT_FOUND');
  assert.equal(outra.body.error.message, 'Empresa não encontrada ou sem acesso.');
  const grupo = await post(body({ groupId: env.B.groupId }));
  assert.equal(grupo.status, 404);
  const sem = await post(body({ companyId: '00000000-0000-4000-8000-000000000000' }));
  assert.equal(sem.status, 404);
});

test('m9d701 corpo inválido é 400 e nada entra na fila', async () => {
  for (const bad of [{}, { target: {} }, { target: { metricCode: 'x' } }, { target: { metricCode: metric.code, dashboardCode: 'crm' } }, body({ filters: { sql: 'x' } }), body({ period: '2099-01-01' }), body({ period: 'ontem' }),
    body({ companyId: env.A.companyId, groupId: env.A.groupId }), { target: { drilldown: { metricCode: metric.code } } }]) {
    const res = await post(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test('m9d701 export de métrica degradada é bloqueado', async () => {
  const ruim = await e.metricWithSeries(env, { series: 1 });
  await e.recordCheck(env.A, { metrics: [ruim.code] });
  const res = await post({ target: { metricCode: ruim.code } });
  assert.equal(res.status, 409);
  assert.equal(code(res), 'ANALYTICS_EXPORT_DEGRADED_BLOCKED');
  assert.equal(res.body.error.message, 'O indicador está com dado incompleto e não pode ser exportado agora.');
  const jobs = (await env.admin.query('SELECT count(*)::int AS n FROM analytics.export_jobs WHERE metric_code = :m', { replacements: { m: ruim.code } }))[0][0].n;
  assert.equal(jobs, 0);
});

test('m9d701 filtros e escopo congelados não mudam', async () => {
  const res = await post(body({ filters: { dimensionKeys: ['s2', 's1'] } }));
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const before = await e.jobRow(env, res.body.data.jobId);
  assert.deepEqual(before.filters, { dimensionKeys: ['s1', 's2'] });
  assert.equal(before.scope.estimatedRows, 3, 'o recorte por série vale no volume estimado');
  await e.inTx(env.A, { commit: true }, async (tx) => {
    await e.store.enableAnalyticsWriter(tx);
    for (const patch of [{ filters: { dimensionKeys: [] } }, { scope: { kind: 'DASHBOARD' } }, { requestedBy: env.A.otherId }, { riskLevel: 'LOW' }, { metricCode: 'fin.outra' }]) {
      await assert.rejects(() => updateExportJobState(before.id, patch, tx), (err) => err.code === 'ANALYTICS_EXPORT_SCOPE_FROZEN');
    }
  });
  // UPDATE direto também é barrado pelo gatilho do banco (ANA07)
  await assert.rejects(() => env.admin.query("UPDATE analytics.export_jobs SET filters = '{}'::jsonb WHERE id = :id", { replacements: { id: before.id } }), /congelados/);
  const after = await e.jobRow(env, before.id);
  assert.deepEqual([after.filters, after.scope], [before.filters, before.scope]);
  // as rotas não alteram nada: PATCH/PUT/DELETE em /analytics/exports não existem
  for (const method of ['PATCH', 'PUT', 'DELETE']) assert.ok([404, 405].includes((await env.http(method, `/analytics/exports/${before.id}`, { body: {} })).status));
});

test('m9d701 estados: transição fora da regra é 409 ANALYTICS_EXPORT_INVALID_TRANSITION', async () => {
  const res = await post(body());
  const id = res.body.data.jobId;
  await e.inTx(env.A, { commit: true }, async (tx) => {
    await e.store.enableAnalyticsWriter(tx);
    await assert.rejects(() => updateExportJobState(id, { status: 'EXPIRED' }, tx), (err) => err.statusCode === 409 && err.code === 'ANALYTICS_EXPORT_INVALID_TRANSITION');
    await assert.rejects(() => updateExportJobState(id, { status: 'READY', rowCount: 1, fileSha256: 'a'.repeat(64), expiresAt: new Date() }, tx), (err) => err.code === 'ANALYTICS_EXPORT_INVALID_TRANSITION');
    await updateExportJobState(id, { status: 'RUNNING' }, tx);
    await updateExportJobState(id, { status: 'FAILED', errorCode: 'X' }, tx);
    await assert.rejects(() => updateExportJobState(id, { status: 'RUNNING' }, tx), (err) => err.code === 'ANALYTICS_EXPORT_INVALID_TRANSITION');
  });
});
