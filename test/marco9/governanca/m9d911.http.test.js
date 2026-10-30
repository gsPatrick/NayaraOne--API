'use strict';

// M9-D911 — /retention pela API real (banco descartável): permissão, recusas do livro, simulação, e o apply como ação da linha 10 da M9-D852 (MFA, Idempotency-Key,
// código da rodada, impacto e 409 se o impacto mudou). O MFA recente é gravado no banco descartável (nunca por endpoint de MFA, nunca token forjado).
process.env.PORT = process.env.M9D911_HTTP_TEST_PORT || '21911';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d911Env');
const http = require('../_helpers/m9d806Http');
const { confirmationFor, grantRecentMfa, revokeRecentMfa } = require('../_helpers/m9d852Confirm');

const MANAGE = 'governance:retention:manage';
const GRANTS = { 'CI GESTOR': ['governance:data-quality:read', MANAGE], 'CI LEITURA': ['governance:data-quality:read'] };
let h;
let A;
const key = (label) => `qa-m9d911-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OLD = '2023-01-15T12:00:00Z';

before(async () => {
  h = await http.startHttp({ port: process.env.PORT, grants: GRANTS, logins: { gestorA: ['A', 'gestor'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
  if (h.skip) return;
  A = h.tenants.A;
  await env.resetRetention(A); await env.resetRetention(h.tenants.B); await env.clearSignals(A);
});
after(async () => {
  if (!h.skip) {
    await revokeRecentMfa(A.userId); // não deixa MFA recente para os testes que exigem a recusa sem ele
    await env.clearSignals(A); await env.resetRetention(A); await env.resetRetention(h.tenants.B);
    await env.adminQuery("DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = 'CI GESTOR' AND p.code = $1", [MANAGE]);
  }
  await http.stopHttp(GRANTS);
});
const call = (who, method, path, body, headers) => h.call(who, method, path, body, headers);
const dryRun = async () => { const res = await call('gestorA', 'POST', '/retention/dry-run', { policy_codes: ['LOGS_TECNICOS'] }); assert.equal(res.status, 201, JSON.stringify(res.body)); return res.body.data; };

test('m9d911 sem a permissão governance:retention:manage: ler com a permissão de qualidade vale, mudar e simular são 403 (nada gravado)', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const read = await call('leituraA', 'GET', '/retention/policies');
  assert.equal(read.status, 200);
  assert.ok(read.body.data.some((p) => p.code === 'REVIEW_DEFAULT'));
  for (const [method, path, body] of [['PUT', '/retention/policies', { code: 'X' }], ['POST', '/retention/dry-run', {}], ['POST', '/retention/runs/00000000-0000-4000-8000-000000000000/apply', {}]]) {
    const res = await call('leituraA', method, path, body, { 'Idempotency-Key': key('perm') });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual([res.body.error.code, res.body.error.details.required], ['PERMISSION_DENIED', MANAGE]);
  }
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.retention_runs WHERE company_id = $1', [A.companyId])).rows[0].n, 0);
});

test('m9d911 PUT /retention/policies: as três recusas do livro, o envelope em português, a alteração e o isolamento', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const good = { code: 'HTTP_POL', name: 'Política HTTP', retention_months: 12, trigger: 'TRANSACTION_DATE', legal_basis: { code: 'LGPD_ART7_II_OBRIGACAO_LEGAL', reference_text: 'CTN art. 173' }, disposition: 'DELETE', exceptions: ['LEGAL_HOLD'], owner_domain: 'FISCAL', data_types: [] };
  const noBasis = await call('gestorA', 'PUT', '/retention/policies', { ...good, legal_basis: undefined });
  assert.deepEqual([noBasis.status, noBasis.body.error.code, noBasis.body.error.message], [422, 'GOV_RETENTION_LEGAL_BASIS_REQUIRED', 'Informe a base legal da política de retenção.']);
  const negative = await call('gestorA', 'PUT', '/retention/policies', { ...good, retention_months: -3 });
  assert.deepEqual([negative.status, negative.body.error.code, negative.body.error.message], [422, 'GOV_RETENTION_PERIOD_INVALID', 'O prazo de retenção é inválido.']);
  const noHold = await call('gestorA', 'PUT', '/retention/policies', { ...good, exceptions: ['TAX_AUDIT'] });
  assert.deepEqual([noHold.status, noHold.body.error.code], [422, 'GOV_RETENTION_HOLD_EXCEPTION_REQUIRED']);
  assert.ok(noHold.body.error.traceId, 'traceId no envelope');
  const created = await call('gestorA', 'PUT', '/retention/policies', good);
  assert.deepEqual([created.status, created.body.data.version, created.body.meta.changed, created.body.data.approvedBy], [200, 1, true, A.userId]);
  const same = await call('gestorA', 'PUT', '/retention/policies', good);
  assert.deepEqual([same.body.data.version, same.body.meta.changed], [1, false]);
  const listB = await call('gestorB', 'GET', '/retention/policies');
  assert.equal(listB.status, 200);
  assert.equal(listB.body.data.some((p) => p.code === 'HTTP_POL'), false, 'a política da empresa A não aparece na B');
});

test('m9d911 POST /retention/dry-run grava a rodada sem alterar dados; GET devolve o relatório e os itens; outra empresa não vê', async (t) => {
  if (h.skip) return t.skip(h.skip);
  await env.clearSignals(A);
  await env.insertSignals(A, 7, OLD);
  const run = await dryRun();
  assert.equal(await env.countSignals(A), 7);
  assert.deepEqual([run.status, run.mode], ['DRY_DONE', 'DRY']);
  const logs = run.report.policies.find((p) => p.code === 'LOGS_TECNICOS');
  assert.deepEqual([logs.eligibleCount, logs.wouldDelete, logs.blockedByHold, logs.blockedByException, logs.forReview], [7, 7, 0, 0, 0]);
  const detail = await call('gestorA', 'GET', `/retention/runs/${run.id}?pageSize=5`);
  assert.equal(detail.status, 200);
  assert.deepEqual([detail.body.data.itemsTotal, detail.body.data.items.length, detail.body.pagination.pageSize], [7, 5, 5]);
  const list = await call('gestorA', 'GET', '/retention/runs');
  assert.ok(list.body.data.some((r) => r.id === run.id));
  const other = await call('gestorB', 'GET', `/retention/runs/${run.id}`);
  assert.deepEqual([other.status, other.body.error.code, other.body.error.message], [404, 'GOV_NOT_FOUND', 'Rodada de retenção não encontrada.']);
  const unknown = await call('gestorA', 'GET', '/retention/runs/nao-e-uuid');
  assert.equal(unknown.status, 404);
});

test('m9d911 apply pela API: Idempotency-Key, MFA, simulação prévia, código da rodada e impacto; impacto mudado é 409; segunda vez é 409', async (t) => {
  if (h.skip) return t.skip(h.skip);
  await env.clearSignals(A);
  await env.insertSignals(A, 12, OLD);
  const run = await dryRun();
  const path = `/retention/runs/${run.id}/apply`;
  await revokeRecentMfa(A.userId);
  const noKey = await call('gestorA', 'POST', path, {});
  assert.deepEqual([noKey.status, noKey.body.error.code], [400, 'GOV_IDEMPOTENCY_KEY_REQUIRED']);
  const noMfa = await call('gestorA', 'POST', path, {}, { 'Idempotency-Key': key('nomfa') });
  assert.equal(noMfa.status, 403);
  assert.ok(['MFA_STEP_UP_REQUIRED', 'MFA_REQUIRED_NOT_ENABLED'].includes(noMfa.body.error.code), noMfa.body.error.code);
  await grantRecentMfa(A);

  const missing = await call('gestorA', 'POST', '/retention/runs/00000000-0000-4000-8000-000000000000/apply', {}, { 'Idempotency-Key': key('nodry') });
  assert.deepEqual([missing.status, missing.body.error.code, missing.body.error.message], [409, 'GOV_RETENTION_DRY_RUN_REQUIRED', 'Execute a simulação antes de aplicar.']);

  const first = await confirmationFor(h, 'gestorA', `/retention/runs/${run.id}/impact`);
  assert.equal(first.impact.level, 3);
  assert.match(first.impact.record.code, /^RET-[0-9A-F]{8}$/);
  assert.deepEqual([first.impact.counts.pending, first.impact.counts.byTable['governance.access_signals'], first.impact.blockers], [12, 12, []]);
  const unconfirmed = await call('gestorA', 'POST', path, {}, { 'Idempotency-Key': key('semconf') });
  assert.deepEqual([unconfirmed.status, unconfirmed.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  assert.equal(await env.countSignals(A), 12, 'nada executa sem a confirmação');

  const items = await env.items(run.id);
  await env.adminQuery("UPDATE governance.retention_run_items SET state = 'SKIPPED_EXCEPTION' WHERE id = $1", [items[0].id]); // o impacto muda depois do token
  const changed = await call('gestorA', 'POST', path, { confirmation: first.confirmation }, { 'Idempotency-Key': key('mudou') });
  assert.deepEqual([changed.status, changed.body.error.code], [409, 'GOV_ACTION_IMPACT_CHANGED']);
  assert.equal(await env.countSignals(A), 12);

  const second = await confirmationFor(h, 'gestorA', `/retention/runs/${run.id}/impact`);
  assert.equal(second.impact.counts.pending, 11);
  const applyKey = key('ok');
  const ok = await call('gestorA', 'POST', path, { confirmation: second.confirmation }, { 'Idempotency-Key': applyKey });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'APPLIED');
  assert.equal(await env.countSignals(A), 1, 'só os 11 do conjunto confirmado foram apagados');
  const confirmed = await env.audits(A, 'governance.action.confirmed', run.id);
  assert.equal(confirmed.length >= 1, true, 'a confirmação foi auditada');
  const replay = await call('gestorA', 'POST', path, { confirmation: second.confirmation }, { 'Idempotency-Key': applyKey });
  assert.equal(replay.headers.get('idempotent-replay'), 'true', 'mesma chave devolve a resposta original');
  const again = await call('gestorA', 'POST', path, {}, { 'Idempotency-Key': key('denovo') });
  assert.deepEqual([again.status, again.body.error.code], [409, 'GOV_RETENTION_ALREADY_APPLIED']);
});
