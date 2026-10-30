'use strict';

// M9-D852 (critérios transferidos da M9-D805 e da M9-D808) — unir cadastros (MERGED, linha 8) e alteração em massa (linha 9) com confirmação nível 3 pela API real.
// O MFA recente é gravado no banco descartável (nunca por endpoint de MFA, nunca token forjado).
process.env.PORT = process.env.M9D852_UNIAO_TEST_PORT || '21854';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d805Env');
const bulkEnv = require('../_helpers/m9d808Env');
const http = require('../_helpers/m9d806Http');
const { withTenantTransaction } = require('../../testHelpers');
const { confirmationFor, withConfirmation, grantRecentMfa } = require('../_helpers/m9d852Confirm');
const { DISPOSABLE, SKIP_DISPOSABLE } = require('../../m9d801.helpers');

let h;
let A;
const key = (label) => `qa-m9d852-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

before(async () => {
  if (!DISPOSABLE) { h = { skip: SKIP_DISPOSABLE }; return; }
  h = await http.startHttp({ port: process.env.PORT, grants: { 'CI GESTOR': ['governance:data-quality:read', 'governance:data-quality:manage', 'governance:data-quality:bulk', 'governance:api:manage'] }, logins: { gestor: ['A', 'gestor'] } });
  A = h.tenants && h.tenants.A;
  if (h.skip) return;
  const stewardship = require('../../../src/features/core-governance/data-quality/stewardship.service');
  await withTenantTransaction(A, (tx) => stewardship.designate(A, env.actorOf(A), 'PESSOAS', { designations: [{ role: 'STEWARD', userId: A.userId }] }, tx));
});
after(async () => { if (!h.skip) await http.stopHttp({ 'CI GESTOR': 1 }); else process.exit(0); });

const pair = () => withTenantTransaction(A, async (tx) => {
  const first = await env.person(A, tx, { legalName: 'QA-M9 Duplicada D852' });
  const second = await env.person(A, tx, { legalName: 'QA-M9 Duplicada D852' });
  const item = await env.candidate(A, tx, 'PERSON', first.id, second.id);
  return { first, second, item };
});

test('m9d852 unir cadastros: GET /impact devolve o impactToken e a lista de contagens; MERGED sem o código do registro é 422 GOV_CONFIRMATION_REQUIRED', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const { item, first, second } = await pair();
  await grantRecentMfa(A);
  const impact = (await h.call('gestor', 'GET', `/data-quality/queue/${item.id}/impact?survivorId=${item.primary_id}`)).body.data;
  assert.equal(impact.level, 3);
  assert.equal(impact.mfaRequired, true);
  assert.match(impact.record.code, /^CAD-[0-9A-F]{8}$/);
  assert.ok(impact.counts && typeof impact.totalAmountCents === 'number' && Array.isArray(impact.blockers), 'counts, totalAmountCents e blockers da D805 continuam');
  assert.ok(impact.impactToken);
  const bare = await h.call('gestor', 'POST', `/data-quality/queue/${item.id}/decision`, { decision: 'MERGED', survivorId: item.primary_id });
  assert.deepEqual([bare.status, bare.body.error.code, bare.body.error.message], [422, 'GOV_CONFIRMATION_REQUIRED', 'Confirme a ação digitando o código do registro.']);
  const wrongCode = await h.call('gestor', 'POST', `/data-quality/queue/${item.id}/decision`, { decision: 'MERGED', survivorId: item.primary_id, confirmation: { understood: true, impactToken: impact.impactToken, typedCode: 'CAD-00000000', justification: 'Mesma pessoa cadastrada duas vezes pelo balcão.' } });
  assert.deepEqual(wrongCode.body.error.details.missing, ['typedCode']);
  const { rows } = await require('../../m9d801.helpers').adminQuery('SELECT status FROM people.persons WHERE id = ANY($1)', [[first.id, second.id]]);
  assert.deepEqual(rows.map((r) => r.status), ['ACTIVE', 'ACTIVE'], 'nada foi unido');
});

test('m9d852 unir cadastros com a confirmação completa une; outras decisões da fila não pedem confirmação; repetir devolve 409', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const { item } = await pair();
  await grantRecentMfa(A);
  const body = await withConfirmation(h, 'gestor', `/data-quality/queue/${item.id}/impact?survivorId=${item.primary_id}`, { decision: 'MERGED', survivorId: item.primary_id });
  const ok = await h.call('gestor', 'POST', `/data-quality/queue/${item.id}/decision`, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'MERGED');
  const again = await h.call('gestor', 'POST', `/data-quality/queue/${item.id}/decision`, body);
  assert.ok([409, 422].includes(again.status), 'repetir não une de novo');
  const other = await pair();
  const kept = await h.call('gestor', 'POST', `/data-quality/queue/${other.item.id}/decision`, { decision: 'KEPT_SEPARATE', note: 'Pessoas diferentes.' });
  assert.equal(kept.status, 200, 'KEPT_SEPARATE segue sem confirmação');
});

test('m9d852 unir cadastros: impacto que mudou entre a simulação e a decisão devolve 409 GOV_ACTION_IMPACT_CHANGED', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const { item, second } = await pair();
  await grantRecentMfa(A);
  const { confirmation } = await confirmationFor(h, 'gestor', `/data-quality/queue/${item.id}/impact?survivorId=${item.primary_id}`);
  await withTenantTransaction(A, (tx) => env.contact(A, tx, item.secondary_id, '+5511900000852'));
  const res = await h.call('gestor', 'POST', `/data-quality/queue/${item.id}/decision`, { decision: 'MERGED', survivorId: item.primary_id, confirmation });
  assert.deepEqual([res.status, res.body.error.code], [409, 'GOV_ACTION_IMPACT_CHANGED']);
  assert.ok(second.id);
});

test('m9d852 lote em massa: nível 3 com código EXECUTAR, impactToken do plano e 409 quando o plano mudou', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const { city } = await withTenantTransaction(A, (tx) => bulkEnv.properties(A, tx, 3));
  await grantRecentMfa(A);
  const plain = bulkEnv.bulkBody(city, { city: 'Cidade Lote D852' });
  const impact = (await h.call('gestor', 'POST', '/data-quality/bulk-changes/impact', plain)).body.data;
  assert.deepEqual([impact.level, impact.record.code, impact.counts.records, impact.counts.willChange], [3, 'EXECUTAR', 3, 3]);
  assert.deepEqual(impact.counts.byRecordType, { PROPERTY: 3 }, 'o agrupamento da D808 continua');
  const bare = await h.call('gestor', 'POST', '/data-quality/bulk-changes', plain, { 'Idempotency-Key': key('bare') });
  assert.deepEqual([bare.status, bare.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  const stale = { ...plain, confirmation: { understood: true, impactToken: impact.impactToken, typedCode: 'EXECUTAR', justification: 'Correção em massa pedida pelo cadastro mestre.' } };
  await withTenantTransaction(A, (tx) => bulkEnv.properties(A, tx, 1, { city }));
  const changed = await h.call('gestor', 'POST', '/data-quality/bulk-changes', stale, { 'Idempotency-Key': key('stale') });
  assert.deepEqual([changed.status, changed.body.error.code], [409, 'GOV_ACTION_IMPACT_CHANGED'], 'o lote ganhou um registro depois da simulação');
});

test('m9d852 criar e revogar credencial de API exigem MFA recente: sem verificação recente é MFA_STEP_UP_REQUIRED e nada é gravado', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const { revokeRecentMfa } = require('../_helpers/m9d852Confirm');
  const { adminQuery } = require('../../m9d801.helpers');
  await grantRecentMfa(A);
  await revokeRecentMfa(A.userId); // o MFA segue habilitado; falta só a verificação recente
  const body = { name: `QA-M9 sem MFA ${Date.now()}`, kind: 'PARTNER', ownerUserId: A.userId, scopes: ['properties:read'] };
  const create = await h.call('gestor', 'POST', '/api-governance/clients', body, { 'Idempotency-Key': key('mfa') });
  assert.deepEqual([create.status, create.body.error.code], [403, 'MFA_STEP_UP_REQUIRED']);
  assert.equal((await adminQuery('SELECT count(*)::int AS n FROM governance.api_clients WHERE name = $1', [body.name])).rows[0].n, 0);
  const impact = (await h.call('gestor', 'POST', '/api-governance/clients/impact', body)).body.data;
  assert.deepEqual([impact.level, impact.mfaRequired, impact.record.code, impact.counts.scopes], [3, true, body.name, 1], 'a simulação não pede MFA: só a ação');
  await grantRecentMfa(A);
  const created = await h.call('gestor', 'POST', '/api-governance/clients', { ...body, confirmation: { understood: true, impactToken: impact.impactToken, typedCode: body.name, justification: 'Credencial para o parceiro de integração QA.' } }, { 'Idempotency-Key': key('mfa2') });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await revokeRecentMfa(A.userId);
  const revoke = await h.call('gestor', 'POST', `/api-governance/clients/${created.body.data.id}/revoke`, {});
  assert.deepEqual([revoke.status, revoke.body.error.code], [403, 'MFA_STEP_UP_REQUIRED']);
  const revokeImpact = (await h.call('gestor', 'GET', `/api-governance/clients/${created.body.data.id}/impact`)).body.data;
  assert.equal(revokeImpact.counts.scopes, 1);
  assert.ok(revokeImpact.items.some((i) => i.type === 'SCOPE' && i.id === 'properties:read'));
  await adminQuery('DELETE FROM governance.api_clients WHERE id = $1', [created.body.data.id]);
});
