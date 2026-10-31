'use strict';

// M9-D904 — /migration/canary pela API real (banco descartável): as duas permissões juntas, avançar com os erros do livro, o rollback como ação da linha 15 da M9-D852 (MFA, motivo,
// código do setor digitado, justificativa, impacto e 409 se o impacto mudou) e o campo `migration` do login. O MFA recente é gravado no banco descartável (nunca por endpoint de
// MFA, nunca token forjado).
process.env.PORT = process.env.M9D904_HTTP_TEST_PORT || '21904';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d904Env');
const http = require('../_helpers/m9d806Http');
const { confirmationFor, grantRecentMfa, revokeRecentMfa } = require('../_helpers/m9d852Confirm');

const RUN = 'governance:migration:run';
const FLAGS = 'governance:flags:manage';
const GRANTS = { 'CI GESTOR': [RUN, FLAGS], 'CI LEITURA': [RUN], 'CI CHECKER': [FLAGS] };
let h; let A;
const call = (who, method, path, body, headers) => h.call(who, method, path, body, headers);

async function setGrants(on) {
  for (const [role, codes] of Object.entries(GRANTS)) {
    await env.adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = ANY($2)', [role, [RUN, FLAGS]]);
    if (on) {
      await env.adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = ANY($2)`, [role, codes]);
    }
  }
}

before(async () => {
  h = await http.startHttp({ port: process.env.PORT, grants: {}, logins: { gestor: ['A', 'gestor'] } });
  if (h.skip) return;
  A = h.tenants.A;
  await setGrants(true);
  // O token do gestor foi emitido antes da concessão: entra de novo para as permissões constarem.
  h.tokens.gestor = (await login('gestor')).token;
  h.tokens.leitura = (await login('leitura')).token;
  h.tokens.checker = (await login('checker')).token;
  await env.cleanup(A);
});
afterEach(async () => { if (h && !h.skip) { await env.cleanup(A); await revokeRecentMfa(A.userId); } });
after(async () => { if (h && !h.skip) { await setGrants(false); await revokeRecentMfa(A.userId); await env.cleanup(A); } await http.stopHttp({}); });

async function login(profile) {
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  for (let i = 0; i < 5; i += 1) {
     
    const res = await fetch(`${h.baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor('A', profile), password: process.env.CI_TENANT_USERS_PASSWORD }) });
     
    const body = await res.json();
    if (res.status === 200) return { token: body.data.accessToken, body };
     
    await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
  }
  throw new Error(`login ${profile}`);
}
const loggedIn = async (profile) => (await login(profile)).body.data;

test('m9d904 avançar e reverter exigem as duas permissões juntas: só uma delas é 403 com a que falta', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const paths = [['POST', '/migration/canary/ATENDIMENTO/advance', {}], ['POST', '/migration/canary/ATENDIMENTO/rollback', { reason: 'x' }], ['GET', '/migration/canary/ATENDIMENTO/impact']];
  for (const [who, missing] of [['leitura', FLAGS], ['checker', RUN]]) {
    for (const [method, path, body] of paths) {
      const res = await call(who, method, path, body);
      assert.equal(res.status, 403, `${who} ${method} ${path}`);
      assert.deepEqual([res.body.error.code, res.body.error.message], ['PERMISSION_DENIED', `Permissão ausente: ${missing}.`]);
    }
  }
  assert.equal(await env.flagRow(A, 'ATENDIMENTO'), null, 'nada foi gravado');
  assert.equal((await call('leitura', 'GET', '/migration/canary')).status, 200, 'a leitura do estado só pede a permissão de migração');
  assert.equal((await call('checker', 'GET', '/migration/canary')).status, 403);
});

test('m9d904 POST /migration/canary/:sector/advance: 200 com o estado, os erros do livro com a mensagem em português e o setor desconhecido é 404', async (t) => {
  if (h.skip) return t.skip(h.skip);
  await env.addSectorUsers(A, 'ATENDIMENTO', 20);
  await env.setEntities(A, 'ATENDIMENTO', ['QA904_LEAD']);
  const first = await call('gestor', 'POST', '/migration/canary/ATENDIMENTO/advance', {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.data.percent, first.body.data.usersTotal, first.body.data.usersInCanary, first.body.data.nextStep], [5, 20, 1, 25]);
  const bad = await call('gestor', 'POST', '/migration/canary/ATENDIMENTO/advance', { percent: 100 });
  assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.message], [422, 'GOV_CANARY_STEP_INVALID', 'Etapa de ativação inválida.']);
  assert.ok(bad.body.error.traceId);
  const off = env.openBlocker('QA904_LEAD');
  try {
    const blocked = await call('gestor', 'POST', '/migration/canary/ATENDIMENTO/advance', {});
    assert.deepEqual([blocked.status, blocked.body.error.code, blocked.body.error.message], [409, 'GOV_CANARY_BLOCKERS_OPEN', 'Há pendências bloqueantes neste setor.']);
  } finally { off(); }
  const same = await call('gestor', 'POST', '/migration/canary/ATENDIMENTO/advance', { percent: 5 });
  assert.deepEqual([same.status, same.body.data.unchanged], [200, true]);
  assert.equal((await call('gestor', 'POST', '/migration/canary/COZINHA/advance', {})).status, 404);
  const state = await call('gestor', 'GET', '/migration/canary');
  assert.deepEqual(state.body.data.sectors.map((s) => [s.sector, s.percent]), [['ATENDIMENTO', 5], ['LOCACAO', 0], ['FINANCEIRO', 0], ['OBRAS', 0], ['CORRESPONDENTE', 0], ['JURIDICO', 0]]);
});

test('m9d904 rollback pela API: MFA, motivo, código do setor, justificativa, impacto mudado é 409 e setor já em 0% é 409', async (t) => {
  if (h.skip) return t.skip(h.skip);
  await env.addSectorUsers(A, 'ATENDIMENTO', 20);
  await env.setEntities(A, 'ATENDIMENTO', ['QA904_LEAD']);
  await env.advance(A, 'ATENDIMENTO'); await env.advance(A, 'ATENDIMENTO');
  const path = '/migration/canary/ATENDIMENTO/rollback'; const impactPath = '/migration/canary/ATENDIMENTO/impact';
  await revokeRecentMfa(A.userId);
  const noMfa = await call('gestor', 'POST', path, { reason: 'ensaio' });
  assert.equal(noMfa.status, 403);
  assert.ok(['MFA_STEP_UP_REQUIRED', 'MFA_REQUIRED_NOT_ENABLED'].includes(noMfa.body.error.code), noMfa.body.error.code);
  await grantRecentMfa(A);

  const noReason = await call('gestor', 'POST', path, {});
  assert.deepEqual([noReason.status, noReason.body.error.code, noReason.body.error.message], [422, 'GOV_CANARY_REASON_REQUIRED', 'Informe o motivo do retorno.']);
  const first = await confirmationFor(h, 'gestor', impactPath, { justification: 'Divergência encontrada no ensaio do atendimento.' });
  assert.deepEqual([first.impact.level, first.impact.record.code, first.impact.counts.percent, first.impact.counts.usersInCanary, first.impact.items.length], [3, 'ATENDIMENTO', 25, 5, 5]);
  assert.equal(first.impact.mfaRequired, true);
  const unconfirmed = await call('gestor', 'POST', path, { reason: 'ensaio' });
  assert.deepEqual([unconfirmed.status, unconfirmed.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  const wrongCode = await call('gestor', 'POST', path, { confirmation: { ...first.confirmation, typedCode: 'OBRAS' } });
  assert.deepEqual([wrongCode.status, wrongCode.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED'], 'sem o código do setor digitado, 422');
  assert.equal(await env.percentOf(A, 'ATENDIMENTO'), 25, 'as recusas não mexeram na flag');

  await env.advance(A, 'ATENDIMENTO'); // o impacto muda depois do token: 50% são 10 usuários
  const changed = await call('gestor', 'POST', path, { confirmation: first.confirmation });
  assert.deepEqual([changed.status, changed.body.error.code], [409, 'GOV_ACTION_IMPACT_CHANGED']);
  assert.equal(await env.percentOf(A, 'ATENDIMENTO'), 50);

  const second = await confirmationFor(h, 'gestor', impactPath, { justification: 'Divergência encontrada no ensaio do atendimento.' });
  assert.equal(second.impact.counts.usersInCanary, 10);
  const ok = await call('gestor', 'POST', path, { confirmation: second.confirmation });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.data.previousPercent, ok.body.data.percent, ok.body.data.usersInCanary], [50, 0, 0]);
  const [audit] = (await env.auditOf(A, 'migration.canary.rolled_back')).slice(-1);
  assert.equal(audit.reason, 'Divergência encontrada no ensaio do atendimento.', 'a justificativa confirmada é o motivo do retorno');
  assert.equal((await env.auditOf(A, 'governance.action.confirmed')).some((row) => row.after_json.actionKey === 'migration.canary.rollback'), true);
  const again = await call('gestor', 'POST', path, { reason: 'de novo' });
  assert.deepEqual([again.status, again.body.error.code], [409, 'GOV_ACTION_BLOCKED']);
  assert.equal((await call('gestor', 'GET', '/migration/canary/COZINHA/impact')).status, 404);
});

test('m9d904 o login devolve o sistema do usuário: dentro do canary opera no novo, fora segue no antigo', async (t) => {
  if (h.skip) return t.skip(h.skip);
  await env.setParam(A, 'governanca.bcp.setor_por_papel', JSON.stringify({ ATENDIMENTO: ['CI LEITURA'] }));
  await env.setEntities(A, 'ATENDIMENTO', ['QA904_LEAD']);
  const before = (await loggedIn('leitura')).migration;
  assert.deepEqual([before.newSystem, before.sectors], [false, [{ sector: 'ATENDIMENTO', percent: 0, newSystem: false }]]);
  for (let i = 0; i < 4; i += 1) await env.advance(A, 'ATENDIMENTO');
  assert.deepEqual((await loggedIn('leitura')).migration, { newSystem: true, sectors: [{ sector: 'ATENDIMENTO', percent: 100, newSystem: true }] });
  assert.equal((await loggedIn('checker')).migration.newSystem, false, 'quem não é do setor segue no antigo');
  await env.rollback(A, 'ATENDIMENTO', { reason: 'fim do ensaio' });
  assert.equal((await loggedIn('leitura')).migration.newSystem, false);
});
