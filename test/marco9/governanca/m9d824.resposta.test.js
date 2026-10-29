'use strict';

// M9-D824 — resposta ao IAM e revisão humana: suspensão de EXPORT/SHARE/PRINT sem derrubar a sessão, MFA novo na próxima ação sensível, CONFIRMED que prorroga e expira
// sozinha, FALSE_POSITIVE que zera os flags. Banco descartável (ver m9d824.deteccao.test.js).
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d824Env');
const review = require('../../../src/features/core-governance/dlp/anomaly.review');
const mfa = require('../../../src/features/users/mfa.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.clean(); } });
afterEach(async () => { env.teardown(); if (env.DISPOSABLE) await env.clean(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const userA = () => tenants.A.userId;
const actor = () => ({ userId: tenants.A.userId });
const reviewOf = (id, body) => env.withTenantTransaction(A(), (tx) => review.reviewAnomaly(A(), actor(), id, body, tx));
const mfaRecent = () => env.withRollbackTenantTransaction(A(), (tx) => mfa.hasRecentMfa(userA(), tx));
const stepUp = (verifiedMinutesAgo, validMinutes = 60) => env.adminQuery(
  `INSERT INTO core.mfa_step_ups (id, user_id, group_id, company_id, verified_at, expires_at, created_at, updated_at)
   VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now()) ON CONFLICT (user_id) DO UPDATE SET verified_at = EXCLUDED.verified_at, expires_at = EXCLUDED.expires_at`,
  [userA(), A().groupId, A().companyId, env.minutesAgo(verifiedMinutesAgo), new Date(Date.now() + validMinutes * 60000)]
);
const burst = async () => { env.setup({ default: 'LOW' }); for (let i = 0; i < 3; i += 1) await env.exportOf(A(), userA(), { idempotencyKey: `b-${env.randomUUID()}` }); return (await env.anomaliesOf(A(), 'OPEN'))[0]; };

test('m9d824 a anomalia suspende EXPORT e SHARE, não o login', { skip: skip() }, async () => {
  await burst();
  for (const action of ['EXPORT', 'SHARE', 'PRINT']) {
    const out = await env.exportOf(A(), userA(), { action, kind: action });
    assert.deepEqual([out.decision, out.blockReason, out.errorCode, out.httpStatus], ['DENY', 'SUSPENDED', 'GOV_DLP_USER_SUSPENDED', 403], action);
  }
  env.setup({ default: 'HIGH' });
  const view = await env.touch(A(), userA(), 'VIEW', 1);
  const copy = await env.touch(A(), userA(), 'COPY', 1);
  assert.deepEqual([view.decision, copy.decision], ['ALLOW', 'ALLOW'], 'VIEW e COPY seguem liberados');
  const sessions = (await env.adminQuery('SELECT count(*)::int AS n FROM core.sessions WHERE user_id = $1 AND revoked_at IS NOT NULL', [userA()])).rows[0].n;
  assert.equal(sessions, 0, 'nenhuma sessão foi revogada');
  const other = await env.exportOf(tenants.B, tenants.B.userId);
  assert.equal(other.decision, 'ALLOW', 'outro usuário não é afetado');
});

test('m9d824 a anomalia força MFA na próxima ação', { skip: skip() }, async () => {
  env.setup({ default: 'LOW' });
  await stepUp(30);
  assert.equal(await mfaRecent(), true, 'antes da anomalia o MFA de 30 minutos atrás vale');
  await burst();
  assert.equal(await mfaRecent(), false, 'depois da detecção o MFA anterior não vale mais');
  await stepUp(0);
  assert.equal(await mfaRecent(), true, 'um MFA novo, verificado depois da detecção, vale');
  await env.adminQuery("UPDATE governance.user_dlp_state SET mfa_step_up_forced_until = now() - interval '1 minute'");
  await stepUp(5);
  assert.equal(await mfaRecent(), true, 'vencido o prazo do MFA forçado, volta ao normal');
});

test('m9d824 CONFIRMED prorroga a suspensão e ela cai ao vencer', { skip: skip() }, async () => {
  const anomaly = await burst();
  const confirmed = await reviewOf(anomaly.id, { decision: 'CONFIRMED', reason: 'Exportou sem pedido do gestor.' });
  assert.equal(confirmed.status, 'CONFIRMED');
  const hours = (new Date(confirmed.restrictedUntil).getTime() - Date.now()) / 3600000;
  assert.ok(hours > 167.9 && hours <= 168.01, 'decisão + 168 h');
  assert.equal(new Date((await env.stateOf(A(), userA())).dlp_restricted_until).getTime(), new Date(confirmed.restrictedUntil).getTime());
  const blocked = await env.exportOf(A(), userA());
  assert.equal(blocked.blockReason, 'SUSPENDED');
  await env.adminQuery("UPDATE governance.access_anomalies SET restricted_until = now() - interval '1 minute'; UPDATE governance.user_dlp_state SET dlp_restricted_until = now() - interval '1 minute'");
  const after = await env.exportOf(A(), userA());
  assert.equal(after.decision, 'ALLOW', 'vencida a suspensão, cai sozinha');
  const audit = (await env.auditOf(A(), 'governance.dlp.anomaly.reviewed')).filter((row) => row.entity_id === anomaly.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].after_json.reason, 'Exportou sem pedido do gestor.');
});

test('m9d824 FALSE_POSITIVE zera os flags na hora e CONFIRMED pode ser revertida com motivo', { skip: skip() }, async () => {
  await stepUp(30);
  const anomaly = await burst();
  const fp = await reviewOf(anomaly.id, { decision: 'FALSE_POSITIVE', reason: 'Fechamento mensal conferido com o contador.' });
  assert.deepEqual([fp.status, fp.restrictedUntil, fp.mfaForcedUntil], ['FALSE_POSITIVE', null, null]);
  const state = await env.stateOf(A(), userA());
  assert.deepEqual([state.dlp_restricted_until, state.mfa_step_up_forced_until, state.mfa_forced_since], [null, null, null]);
  assert.equal((await env.exportOf(A(), userA())).decision, 'ALLOW', 'liberado na hora');
  assert.equal(await mfaRecent(), true, 'o MFA anterior volta a valer');
  await burst();
  const open = (await env.anomaliesOf(A(), 'OPEN'))[0];
  const confirmed = await reviewOf(open.id, { decision: 'CONFIRMED', reason: 'Confirmado pelo gestor.' });
  assert.equal(confirmed.status, 'CONFIRMED');
  const back = await reviewOf(open.id, { decision: 'FALSE_POSITIVE', reason: 'Revisão posterior mostrou autorização.' });
  assert.equal(back.status, 'FALSE_POSITIVE');
  assert.equal((await env.stateOf(A(), userA())).dlp_restricted_until, null);
});

test('m9d824 uma anomalia liberada não solta a suspensão de outra ainda aberta', { skip: skip() }, async () => {
  const exportAnomaly = await burst();
  env.setup({ default: 'HIGH' });
  await env.touch(A(), userA(), 'VIEW', 201);
  const open = await env.anomaliesOf(A(), 'OPEN');
  assert.equal(open.length, 2);
  await reviewOf(exportAnomaly.id, { decision: 'FALSE_POSITIVE', reason: 'Exportação autorizada.' });
  const state = await env.stateOf(A(), userA());
  assert.ok(new Date(state.dlp_restricted_until) > new Date(), 'a anomalia de leitura continua suspendendo');
});

test('m9d824 revisão exige motivo, decisão válida e respeita as transições', { skip: skip() }, async () => {
  const anomaly = await burst();
  const code = (body) => env.codeOf(reviewOf(anomaly.id, body));
  assert.deepEqual(await code({ decision: 'CONFIRMED', reason: '   ' }).then((e) => [e.status, e.code, e.message]), [400, 'GOV_ANOMALY_REASON_REQUIRED', 'Informe o motivo da revisão.']);
  assert.deepEqual(await code({ decision: 'FALSE_POSITIVE' }).then((e) => [e.status, e.code]), [400, 'GOV_ANOMALY_REASON_REQUIRED']);
  assert.deepEqual(await code({ decision: 'OPEN', reason: 'x' }).then((e) => [e.status, e.code]), [400, 'GOV_DLP_REQUEST_INVALID']);
  assert.equal((await env.anomaliesOf(A(), 'OPEN')).length, 1, 'nada mudou');
  await reviewOf(anomaly.id, { decision: 'FALSE_POSITIVE', reason: 'Conferido.' });
  assert.deepEqual(await code({ decision: 'CONFIRMED', reason: 'Mudei de ideia.' }).then((e) => [e.status, e.code]), [409, 'GOV_ANOMALY_INVALID_TRANSITION']);
  const missing = await env.codeOf(env.withTenantTransaction(A(), (tx) => review.reviewAnomaly(A(), actor(), env.randomUUID(), { decision: 'CONFIRMED', reason: 'x' }, tx)));
  assert.deepEqual([missing.status, missing.code], [404, 'GOV_NOT_FOUND']);
  const other = await env.codeOf(env.withTenantTransaction(tenants.B, (tx) => review.reviewAnomaly(tenants.B, { userId: tenants.B.userId }, anomaly.id, { decision: 'CONFIRMED', reason: 'x' }, tx)));
  assert.equal(other.status, 404, 'a empresa B não enxerga nem revisa a anomalia de A');
});
