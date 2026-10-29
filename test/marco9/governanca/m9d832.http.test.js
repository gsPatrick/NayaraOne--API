'use strict';

// M9-D832 — importação e reconciliação pela API real (banco descartável): três formulários importados, segunda importação sem duplicar, lote por correlação, divergência decidida,
// permissões, setor, limite do pedido e isolamento entre empresas.
process.env.PORT = process.env.M9D832_HTTP_TEST_PORT || '21832';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d832Env');
const { createReceivable } = require('../_helpers/m9d832More');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let http;
let A;
let ctx;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const RECORD = 'governance:bcp:record';
const IMPORT = 'governance:bcp:import';
const APPROVE = 'governance:bcp:approve';
const CORR = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

before(async () => {
  if (!env.DISPOSABLE) return;
  restore = await env.withRolePermissions({
    'CI GESTOR': { [RECORD]: true, [IMPORT]: true, [APPROVE]: true }, 'CI MAKER': { [RECORD]: true, [IMPORT]: true, [APPROVE]: false }, 'CI LEITURA': { [RECORD]: false, [IMPORT]: false, [APPROVE]: false },
  });
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
  A = http.tenants.A;
  await env.prepare(A);
  ctx = await env.context(A);
});
after(async () => {
  if (env.DISPOSABLE) { await env.cleanImports(); await restore(); }
  await stopHttp({});
});

const importHttp = (who, body) => http.call(who, 'POST', '/bcp/manual-operations/import', body);

test('m9d832 HTTP: importa 3 formulários, o comando nasce com a origem BCP e a segunda importação não duplica', { skip: skip() }, async () => {
  const ops = [await env.recordAction(A, 'REGISTER_LEAD', ctx), await env.recordAction(A, 'EMERGENCY_PAYMENT', ctx), await env.recordAction(A, 'MATERIAL_REQUEST', ctx)];
  const ids = ops.map((o) => o.id);
  const first = await importHttp('gestorA', { ids });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.data.items.map((i) => i.error), [null, null, null]);
  assert.deepEqual([first.body.data.summary.total, first.body.data.summary.reconciled, first.body.data.summary.failed], [3, 3, 0]);
  const payable = first.body.data.items[1];
  const entry = (await env.adminQuery('SELECT origin_ref, idempotency_key FROM finance.financial_entries WHERE id = $1', [payable.commandRef.split(':')[1]])).rows[0];
  assert.deepEqual([entry.origin_ref, entry.idempotency_key], [`bcp:${ops[1].manualReference}`, `bcp:${A.companyId}:${ops[1].manualReference}`]);
  const again = await importHttp('gestorA', { ids });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.data.items.map((i) => i.commandRef), first.body.data.items.map((i) => i.commandRef));
  assert.deepEqual(again.body.data.items.map((i) => i.alreadyImported), [true, true, true]);
  assert.equal(again.body.data.summary.alreadyImported, 3);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM finance.financial_entries WHERE origin_ref = $1', [`bcp:${ops[1].manualReference}`])).rows[0].n, 1);
});

test('m9d832 HTTP: lote por correlation_ref e divergência decidida pelo responsável', { skip: skip() }, async () => {
  const receivableId = await createReceivable(A, ctx.base, 1205);
  const a = await env.recordAction(A, 'RECEIVE_PAYMENT', { ...ctx, receivableId }, { valorCentavos: 125000 }, { correlationRef: CORR });
  const b = await env.recordAction(A, 'REGISTER_DEADLINE', ctx, {}, { correlationRef: CORR });
  const res = await importHttp('gestorA', { correlationRef: CORR });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.items.map((i) => i.reconciliation.result).sort(), ['DIVERGENT', 'MATCHED']);
  const pending = await http.call('gestorA', 'GET', '/bcp/reconciliations?pending=true');
  assert.equal(pending.status, 200);
  const mine = pending.body.data.find((r) => r.manualReference === a.manualReference);
  assert.deepEqual([mine.result, mine.diff[0].differenceCents, mine.sector, mine.operationStatus], ['DIVERGENT', 4500, 'FINANCEIRO', 'IMPORTED']);
  assert.ok(!pending.body.data.some((r) => r.manualReference === b.manualReference), 'conferida sem diferença não espera decisão');
  const noNote = await http.call('gestorA', 'POST', `/bcp/reconciliations/${mine.id}/decide`, { decision: 'ACCEPT' });
  assert.deepEqual([noNote.status, noNote.body.error.code, noNote.body.error.message], [400, 'GOV_BCP_DECISION_NOTE_REQUIRED', 'Informe a justificativa da decisão.']);
  const noPermission = await http.call('makerA', 'POST', `/bcp/reconciliations/${mine.id}/decide`, { decision: 'ACCEPT', note: 'x' });
  assert.deepEqual([noPermission.status, noPermission.body.error.code], [403, 'PERMISSION_DENIED']);
  const decided = await http.call('gestorA', 'POST', `/bcp/reconciliations/${mine.id}/decide`, { decision: 'REVERSE', note: 'Valor não confere.' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.deepEqual([decided.body.data.decision, decided.body.data.operationStatus], ['REVERSE', 'REJECTED']);
  const twice = await http.call('gestorA', 'POST', `/bcp/reconciliations/${mine.id}/decide`, { decision: 'ACCEPT', note: 'y' });
  assert.deepEqual([twice.status, twice.body.error.code], [409, 'GOV_BCP_ALREADY_FINAL']);
  assert.equal((await env.opRow(a.id)).status, 'REJECTED');
});

test('m9d832 HTTP: permissões, corpo, limite do pedido e setor', { skip: skip() }, async () => {
  const op = await env.recordAction(A, 'REGISTER_LEAD', ctx);
  const denied = await importHttp('leituraA', { ids: [op.id] });
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'PERMISSION_DENIED']);
  for (const body of [{}, { ids: [] }, { ids: ['x'] }, { ids: [op.id], correlationRef: CORR }, { correlationRef: 'x' }]) {
    const res = await importHttp('gestorA', body);
    assert.deepEqual([res.status, res.body.error.code], [400, 'VALIDATION_ERROR'], JSON.stringify(body));
  }
  const unknown = await importHttp('gestorA', { correlationRef: '00000000-0000-4000-8000-0000000000aa' });
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'GOV_NOT_FOUND']);
  await env.inTx(A, (tx) => upsertSetting('governanca.bcp.importacao_lote_max', 2, env.tenantOf(A), A.userId, tx));
  const many = [op.id, (await env.recordAction(A, 'REGISTER_LEAD', ctx)).id, (await env.recordAction(A, 'REGISTER_LEAD', ctx)).id];
  const tooMany = await importHttp('gestorA', { ids: many });
  assert.deepEqual([tooMany.status, tooMany.body.error.code], [400, 'VALIDATION_ERROR']);
  assert.match(tooMany.body.error.message, /mais de 2 operações/);
  await env.setSectorRoles(A, { ATENDIMENTO: ['CI GESTOR'], FINANCEIRO: ['CI GESTOR'], OBRAS: ['CI GESTOR', 'CI MAKER'] });
  const fin = await env.recordAction(A, 'EMERGENCY_PAYMENT', ctx);
  const forbidden = await importHttp('makerA', { ids: [fin.id] });
  assert.deepEqual([forbidden.status, forbidden.body.error.code, forbidden.body.error.message], [403, 'GOV_BCP_SECTOR_FORBIDDEN', 'Você não pode importar operações deste setor.']);
  assert.equal((await env.opRow(fin.id)).status, 'RECORDED');
});

test('m9d832 HTTP: isolamento entre empresas na importação, na listagem e na decisão', { skip: skip() }, async () => {
  await env.prepare(A);
  const op = await env.recordAction(A, 'REGISTER_DEADLINE', ctx);
  assert.equal((await importHttp('gestorA', { ids: [op.id] })).status, 200);
  const rec = await env.reconciliationOf(op.id);
  const fromB = await importHttp('gestorB', { ids: [op.id] });
  assert.deepEqual([fromB.status, fromB.body.error.code], [404, 'GOV_NOT_FOUND']);
  const listB = await http.call('gestorB', 'GET', '/bcp/reconciliations');
  assert.equal(listB.status, 200);
  assert.ok(!listB.body.data.some((r) => r.manualReference === op.manualReference));
  const decideB = await http.call('gestorB', 'POST', `/bcp/reconciliations/${rec.id}/decide`, { decision: 'ACCEPT', note: 'x' });
  assert.deepEqual([decideB.status, decideB.body.error.code], [404, 'GOV_NOT_FOUND']);
  assert.equal((await env.importRow(op.id)).imported_by, A.userId);
});
