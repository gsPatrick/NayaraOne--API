'use strict';

// M9-D912 — /legal-holds pela API real (banco descartável): permissão, os erros do livro com a mensagem em português, criação, consulta, isolamento e a liberação como ação da
// linha 11 da M9-D852 (Idempotency-Key, MFA, código digitado, justificativa que vira o motivo, impacto e 409 se o impacto mudou). O MFA recente é gravado no banco descartável
// (nunca por endpoint de MFA, nunca token forjado).
process.env.PORT = process.env.M9D912_HTTP_TEST_PORT || '21912';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d912Env');
const http = require('../_helpers/m9d806Http');
const { confirmationFor, grantRecentMfa, revokeRecentMfa } = require('../_helpers/m9d852Confirm');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const MANAGE = 'governance:legal-hold:manage';
const GRANTS = { 'CI GESTOR': ['governance:data-quality:read', MANAGE], 'CI LEITURA': ['governance:data-quality:read'] };
let h; let A; let B;
const key = (label) => `qa-m9d912-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const call = (who, method, path, body, headers) => h.call(who, method, path, body, headers);
const body = (extra) => ({ code: env.code('HTTP'), reason: 'QA-M9 ação judicial', matter_ref: '0001111-22.2026.8.26.0100', ...extra });

before(async () => {
  h = await http.startHttp({ port: process.env.PORT, grants: GRANTS, logins: { gestorA: ['A', 'gestor'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
  if (h.skip) return;
  ({ A, B } = h.tenants);
  await env.resetHolds(A); await env.resetHolds(B);
});
after(async () => {
  if (!h.skip) {
    await revokeRecentMfa(A.userId);
    await env.adminQuery("DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = 'governanca.legal_hold.pagina_tamanho'", [A.companyId]);
    await env.resetHolds(A); await env.resetHolds(B);
    await env.adminQuery("DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = 'CI GESTOR' AND p.code = $1", [MANAGE]);
  }
  await http.stopHttp(GRANTS);
});

test('m9d912 sem a permissão governance:legal-hold:manage: ler com a permissão de qualidade vale; criar e liberar são 403 (nada gravado)', async (t) => {
  if (h.skip) return t.skip(h.skip);
  assert.equal((await call('leituraA', 'GET', '/legal-holds')).status, 200);
  const person = await env.insertPerson(A);
  for (const [method, path, payload] of [['POST', '/legal-holds', body({ scope: [{ type: 'PERSON', id: person }] })], ['POST', '/legal-holds/00000000-0000-4000-8000-000000000000/release', {}], ['GET', '/legal-holds/00000000-0000-4000-8000-000000000000/impact']]) {
    const res = await call('leituraA', method, path, payload, { 'Idempotency-Key': key('perm') });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual([res.body.error.code, res.body.error.details.required], ['PERMISSION_DENIED', MANAGE]);
  }
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.legal_holds WHERE company_id = $1', [A.companyId])).rows[0].n, 0);
});

test('m9d912 POST /legal-holds: criação 201, os erros do livro com a mensagem em português e o envelope com traceId', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const person = await env.insertPerson(A);
  const scope = [{ type: 'PERSON', id: person }];
  const created = await call('gestorA', 'POST', '/legal-holds', body({ code: 'HTTP-OK-1', scope }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.data.status, created.body.data.createdBy, created.body.data.targets.map((x) => x.entityType)], ['ACTIVE', A.userId, ['PERSON']]);
  const dup = await call('gestorA', 'POST', '/legal-holds', body({ code: 'HTTP-OK-1', scope }));
  assert.deepEqual([dup.status, dup.body.error.code, dup.body.error.message], [409, 'GOV_HOLD_CODE_DUPLICATE', 'Já existe uma retenção com este código.']);
  assert.ok(dup.body.error.traceId);
  const noReason = await call('gestorA', 'POST', '/legal-holds', body({ reason: '', scope }));
  assert.deepEqual([noReason.status, noReason.body.error.code, noReason.body.error.message], [422, 'GOV_HOLD_REASON_REQUIRED', 'Informe o motivo e a referência do processo.']);
  const noRef = await call('gestorA', 'POST', '/legal-holds', body({ matter_ref: undefined, scope }));
  assert.deepEqual([noRef.status, noRef.body.error.code], [422, 'GOV_HOLD_REASON_REQUIRED']);
  const noScope = await call('gestorA', 'POST', '/legal-holds', body({ scope: [] }));
  assert.deepEqual([noScope.status, noScope.body.error.code, noScope.body.error.message], [422, 'GOV_HOLD_SCOPE_REQUIRED', 'Defina o escopo da retenção.']);
  const bad = await call('gestorA', 'POST', '/legal-holds', body({ scope: [{ type: 'NADA' }] }));
  assert.deepEqual([bad.status, bad.body.error.code], [422, 'GOV_HOLD_SCOPE_INVALID']);
  const missing = await call('gestorA', 'POST', '/legal-holds', body({ scope: [{ type: 'PERSON', id: '00000000-0000-4000-8000-0000000000aa' }] }));
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'GOV_NOT_FOUND']);
});

test('m9d912 GET /legal-holds filtra e pagina (tamanho da página é parâmetro) e outra empresa não vê nem libera', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const personA = await env.insertPerson(A); const personB = await env.insertPerson(B);
  const first = await call('gestorA', 'POST', '/legal-holds', body({ scope: [{ type: 'PERSON', id: personA }] }));
  const second = await call('gestorA', 'POST', '/legal-holds', body({ scope: [{ type: 'COMPANY' }] }));
  await call('gestorB', 'POST', '/legal-holds', body({ scope: [{ type: 'PERSON', id: personB }] }));
  const all = await call('gestorA', 'GET', '/legal-holds');
  assert.equal(all.status, 200);
  const ids = all.body.data.map((x) => x.id);
  assert.ok(ids.includes(first.body.data.id) && ids.includes(second.body.data.id));
  assert.equal(all.body.data.every((x) => x.targetCount >= 1), true);
  assert.equal((await call('gestorA', 'GET', '/legal-holds?status=RELEASED')).body.data.length, 0);
  assert.equal((await call('gestorA', 'GET', '/legal-holds?status=ABERTO')).status, 400);
  assert.equal((await call('gestorA', 'GET', `/legal-holds?code=${encodeURIComponent(first.body.data.code)}`)).body.data.length, 1);
  await env.inTx(A, (tx) => upsertSetting('governanca.legal_hold.pagina_tamanho', 1, A, A.userId, tx));
  const paged = await call('gestorA', 'GET', '/legal-holds');
  assert.deepEqual([paged.body.data.length, paged.body.pagination.pageSize], [1, 1], 'o tamanho da página vem do parâmetro');
  const seenByB = await call('gestorB', 'GET', '/legal-holds');
  assert.equal(seenByB.body.data.some((x) => ids.includes(x.id)), false);
  assert.equal((await call('gestorB', 'GET', `/legal-holds/${first.body.data.id}`)).status, 404);
  assert.equal((await call('gestorB', 'GET', `/legal-holds/${first.body.data.id}/impact`)).status, 404);
});

test('m9d912 liberar pela API: Idempotency-Key, MFA, código digitado, justificativa vira o motivo, impacto mudado é 409 e liberar de novo é 409', async (t) => {
  if (h.skip) return t.skip(h.skip);
  await env.resetHolds(A);
  const person = await env.insertPerson(A);
  const created = await call('gestorA', 'POST', '/legal-holds', body({ scope: [{ type: 'PERSON', id: person }] }));
  const id = created.body.data.id; const path = `/legal-holds/${id}/release`;
  await revokeRecentMfa(A.userId);
  const noKey = await call('gestorA', 'POST', path, {});
  assert.deepEqual([noKey.status, noKey.body.error.code], [400, 'GOV_IDEMPOTENCY_KEY_REQUIRED']);
  const noMfa = await call('gestorA', 'POST', path, {}, { 'Idempotency-Key': key('semmfa') });
  assert.equal(noMfa.status, 403);
  assert.ok(['MFA_STEP_UP_REQUIRED', 'MFA_REQUIRED_NOT_ENABLED'].includes(noMfa.body.error.code), noMfa.body.error.code);
  await grantRecentMfa(A);

  const first = await confirmationFor(h, 'gestorA', `/legal-holds/${id}/impact`);
  assert.equal(first.impact.level, 3);
  assert.equal(first.impact.record.code, created.body.data.code, 'o código a digitar é o da retenção');
  assert.deepEqual([first.impact.counts.targets, first.impact.counts.byType, first.impact.blockers], [1, { PERSON: 1 }, []]);
  const unconfirmed = await call('gestorA', 'POST', path, {}, { 'Idempotency-Key': key('semconf') });
  assert.deepEqual([unconfirmed.status, unconfirmed.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  const wrongCode = await call('gestorA', 'POST', path, { confirmation: { ...first.confirmation, typedCode: 'OUTRO' } }, { 'Idempotency-Key': key('codigo') });
  assert.deepEqual([wrongCode.status, wrongCode.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  await assert.rejects(env.assertNotOnHold(A, 'PERSON', person), 'a retenção segue ativa depois das recusas');

  const contract = await env.insertContract(A); await env.addParty(A, contract, person); // o impacto muda depois do token: um contrato novo cai no escopo
  const changed = await call('gestorA', 'POST', path, { confirmation: first.confirmation }, { 'Idempotency-Key': key('mudou') });
  assert.deepEqual([changed.status, changed.body.error.code], [409, 'GOV_ACTION_IMPACT_CHANGED']);
  await assert.rejects(env.assertNotOnHold(A, 'PERSON', person));

  const second = await confirmationFor(h, 'gestorA', `/legal-holds/${id}/impact`, { justification: 'Processo arquivado em definitivo, conforme despacho.' });
  assert.deepEqual(second.impact.counts.byType, { CONTRACT: 1, PERSON: 1 });
  const releaseKey = key('ok');
  const ok = await call('gestorA', 'POST', path, { confirmation: second.confirmation }, { 'Idempotency-Key': releaseKey });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.data.status, ok.body.data.releasedBy, ok.body.data.releaseReason], ['RELEASED', A.userId, 'Processo arquivado em definitivo, conforme despacho.']);
  await env.assertNotOnHold(A, 'PERSON', person);
  assert.equal((await env.auditRows(A, 'governance.action.confirmed')).some((row) => row.after_json.actionKey === 'legal_hold.release'), true, 'a confirmação foi auditada');
  const replay = await call('gestorA', 'POST', path, { confirmation: second.confirmation }, { 'Idempotency-Key': releaseKey });
  assert.equal(replay.headers.get('idempotent-replay'), 'true', JSON.stringify([replay.status, replay.body]));
  const again = await call('gestorA', 'POST', path, {}, { 'Idempotency-Key': key('denovo') });
  assert.deepEqual([again.status, again.body.error.code], [409, 'GOV_ACTION_BLOCKED']);
});
