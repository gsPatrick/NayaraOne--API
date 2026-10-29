'use strict';

// M9-D833 — dupla checagem pela API real (banco descartável): recusas com o status e o código do livro e o caminho feliz.
process.env.PORT = process.env.M9D833_HTTP_TEST_PORT || '21833';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d833Env');

let http;
let A;
let ctx;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
let keySeq = 0;
// A importação exige Idempotency-Key (M9-D843 §3.3): chave nova por chamada.
const importHttp = (who, ids) => { keySeq += 1; return http.call(who, 'POST', '/bcp/manual-operations/import', { ids }, { 'Idempotency-Key': `m9d833-http-${Date.now()}-${keySeq}` }); };

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A } = await env.loadTenants());
  restore = await env.prepare833(A); // as permissões entram no token no login: concedê-las antes
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'] } });
  A = http.tenants.A;
  ctx = await env.context(A);
});
after(async () => { if (env.DISPOSABLE) { await env.clean833(); await restore(); } await stopHttp({}); });

test('m9d833 HTTP: mesma pessoa devolve 403 GOV_BCP_PAYMENT_SAME_PERSON e o lançamento não nasce', { skip: skip() }, async () => {
  const op = await env.recordPayment(A, ctx, {}, { actorUserId: A.userId });
  const res = await importHttp('gestorA', [op.id]);
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'GOV_BCP_PAYMENT_SAME_PERSON');
  assert.equal(res.body.error.message, 'As duas conferências devem ser de pessoas diferentes.');
  assert.ok(res.body.error.traceId);
  assert.equal((await env.entriesOf(op.manualReference)).length, 0);
});

test('m9d833 HTTP: checker_2 sem governance:bcp:approve devolve 403 PERMISSION_DENIED', { skip: skip() }, async () => {
  const op = await env.recordPayment(A, ctx, {}, { actorUserId: A.userId });
  const res = await importHttp('makerA', [op.id]);
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  assert.equal(res.body.error.message, 'Permissão ausente: governance:bcp:approve.');
  assert.equal(await env.importRow(op.id), null);
});

test('m9d833 HTTP: conferentes do papel iguais devolvem 422 GOV_BCP_PAYMENT_DOUBLE_CHECK', { skip: skip() }, async () => {
  const op = await env.recordPayment(A, ctx, { conferente2: 'Ana QA' });
  const res = await importHttp('gestorA', [op.id]);
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'GOV_BCP_PAYMENT_DOUBLE_CHECK');
  assert.equal(res.body.error.message, 'Pagamento manual exige conferência por duas pessoas diferentes.');
  assert.equal((await env.opRow(op.id)).status, 'RECORDED');
});

test('m9d833 HTTP: duas pessoas distintas importam, a pendência de conciliação nasce e a repetição não paga de novo', { skip: skip() }, async () => {
  const op = await env.recordPayment(A, ctx, { valorCentavos: 1200000 });
  const res = await importHttp('gestorA', [op.id]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.items[0].error, null);
  assert.equal((await env.pendingOf(op.id)).status, 'OPEN');
  const again = await importHttp('gestorA', [op.id]);
  assert.equal(again.body.data.items[0].alreadyImported, true);
  assert.equal((await env.entriesOf(op.manualReference)).length, 1);
});
