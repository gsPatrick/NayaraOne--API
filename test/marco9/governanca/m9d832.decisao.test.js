'use strict';

// M9-D832 — decisão da divergência (serviço, banco descartável): ACCEPT, REVERSE com estorno do serviço normal, justificativa obrigatória, decisão final, setor e listagem.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d832Env');
const { createReceivable } = require('../_helpers/m9d832More');
const decideService = require('../../../src/features/core-governance/bcp/import/decide.service');

const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
let A;
let ctx;

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A } = await env.loadTenants());
  await env.prepare(A);
  ctx = await env.context(A);
});
afterEach(async () => { if (env.DISPOSABLE) await env.prepare(A); });
after(async () => { if (env.DISPOSABLE) { await env.cleanImports(); await env.sequelize.close(); } });

/** Recebimento com valor divergente (papel R$ 1.250,00 x parcela R$ 1.205,00), já importado: devolve a operação, a parcela e a reconciliação. */
async function divergentReceipt() {
  const receivableId = await createReceivable(A, ctx.base, 1205);
  const op = await env.recordAction(A, 'RECEIVE_PAYMENT', { ...ctx, receivableId }, { valorCentavos: 125000 });
  await env.importIds(A, [op.id]);
  return { op, receivableId, rec: await env.reconciliationOf(op.id) };
}

test('m9d832 decisão ACCEPT leva a RECONCILED', { skip: skip() }, async () => {
  const { op, rec } = await divergentReceipt();
  const out = await env.decide(A, rec.id, { decision: 'ACCEPT', note: 'Cliente pagou o valor da parcela, o papel estava errado.' });
  assert.deepEqual([out.decision, out.operationStatus, out.decisionNote], ['ACCEPT', 'RECONCILED', 'Cliente pagou o valor da parcela, o papel estava errado.']);
  const stored = await env.reconciliationOf(op.id);
  assert.ok(stored.decided_by && stored.decided_at && stored.reconciled_by && stored.reconciled_at);
  assert.equal(stored.decision_note, 'Cliente pagou o valor da parcela, o papel estava errado.');
  assert.equal((await env.opRow(op.id)).status, 'RECONCILED');
  assert.equal((await env.auditOf(A, 'bcp.reconciliation.decided')).length >= 1, true);
});

test('m9d832 decisão REVERSE leva a REJECTED com o estorno do serviço normal', { skip: skip() }, async () => {
  const { op, receivableId, rec } = await divergentReceipt();
  const out = await env.decide(A, rec.id, { decision: 'REVERSE', note: 'Valor do papel não confere com o recebido.' });
  assert.deepEqual([out.decision, out.operationStatus], ['REVERSE', 'REJECTED']);
  const stored = await env.opRow(op.id);
  assert.deepEqual([stored.status, stored.reject_reason], ['REJECTED', 'Valor do papel não confere com o recebido.']);
  assert.equal((await env.adminQuery('SELECT status FROM finance.financial_entries WHERE id = $1', [receivableId])).rows[0].status, 'REVERSED', 'o recebimento foi estornado pelo Financeiro');
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM finance.financial_entries WHERE reversal_of_entry_id = $1', [receivableId])).rows[0].n, 1, 'lançamento compensatório');
  const rec2 = await env.reconciliationOf(op.id);
  assert.deepEqual([rec2.decision, rec2.reconciled_by], ['REVERSE', null], 'REJECTED não é reconciliada');
});

test('m9d832 a decisão exige justificativa e decisão válida', { skip: skip() }, async () => {
  const { rec } = await divergentReceipt();
  for (const body of [{ decision: 'ACCEPT' }, { decision: 'ACCEPT', note: '   ' }, { decision: 'REVERSE', note: '' }]) {
    const err = await env.failure(env.decide(A, rec.id, body));
    assert.deepEqual([err.status, err.code, err.message], [400, 'GOV_BCP_DECISION_NOTE_REQUIRED', 'Informe a justificativa da decisão.']);
  }
  const invalid = await env.failure(env.decide(A, rec.id, { decision: 'TALVEZ', note: 'x' }));
  assert.deepEqual([invalid.status, invalid.code], [400, 'VALIDATION_ERROR']);
  assert.equal((await env.reconciliationOf(rec.manual_operation_id)).decision, null, 'nada foi decidido');
});

test('m9d832 decidir duas vezes, ou uma conferência sem divergência, devolve 409 GOV_BCP_ALREADY_FINAL', { skip: skip() }, async () => {
  const { rec } = await divergentReceipt();
  await env.decide(A, rec.id, { decision: 'ACCEPT', note: 'ok' });
  const twice = await env.failure(env.decide(A, rec.id, { decision: 'REVERSE', note: 'mudei de ideia' }));
  assert.deepEqual([twice.status, twice.code, twice.message], [409, 'GOV_BCP_ALREADY_FINAL', 'Esta operação já foi concluída.']);
  const matched = await env.recordAction(A, 'REGISTER_DEADLINE', ctx);
  await env.importIds(A, [matched.id]);
  const err = await env.failure(env.decide(A, (await env.reconciliationOf(matched.id)).id, { decision: 'ACCEPT', note: 'sem divergência' }));
  assert.equal(err.code, 'GOV_BCP_ALREADY_FINAL');
});

test('m9d832 ação sem estorno no serviço normal recusa o REVERSE (422) e a divergência pode ser aceita', { skip: skip() }, async () => {
  const op = await env.recordAction(A, 'REGISTER_CASE_PROGRESS', ctx, { data: '2020-01-02' });
  const item = (await env.importIds(A, [op.id])).items[0];
  assert.deepEqual(item.reconciliation.diff.map((d) => d.field), ['data'], 'o serviço grava a data do registro, não a do papel');
  const rec = await env.reconciliationOf(op.id);
  const err = await env.failure(env.decide(A, rec.id, { decision: 'REVERSE', note: 'desfazer' }));
  assert.deepEqual([err.status, err.code], [422, 'GOV_BCP_COMMAND_REJECTED']);
  assert.match(err.message, /^O sistema recusou a operação: o andamento fica no histórico/);
  assert.deepEqual([(await env.opRow(op.id)).status, (await env.reconciliationOf(op.id)).decision], ['IMPORTED', null], 'nada mudou');
  await env.decide(A, rec.id, { decision: 'ACCEPT', note: 'aceito a data de registro' });
  assert.equal((await env.opRow(op.id)).status, 'RECONCILED');
});

test('m9d832 só decide quem é do setor da operação e a listagem mostra o que falta decidir', { skip: skip() }, async () => {
  const { op, rec } = await divergentReceipt();
  const maker = await env.otherUserId();
  await env.setSectorRoles(A, { FINANCEIRO: ['CI GESTOR'], OBRAS: ['CI GESTOR', 'CI MAKER'] });
  const err = await env.failure(env.decide(A, rec.id, { decision: 'ACCEPT', note: 'x' }, maker));
  assert.deepEqual([err.status, err.code, err.message], [403, 'GOV_BCP_SECTOR_FORBIDDEN', 'Você não pode decidir divergências deste setor.']);
  const listFor = (query, userId) => env.inTx(A, (transaction) => decideService.list({ tenant: env.tenantOf(A), actorUserId: userId || A.userId, query, transaction }), userId);
  const pending = (await listFor({ pending: 'true' })).items;
  assert.ok(pending.some((r) => r.manualReference === op.manualReference && r.result === 'DIVERGENT' && r.decision === null && r.sector === 'FINANCEIRO'));
  assert.deepEqual((await listFor({ pending: 'true' }, maker)).items, [], 'o outro setor não enxerga');
  assert.ok((await listFor({ result: 'MATCHED' })).items.every((r) => r.result === 'MATCHED'));
  assert.equal((await env.failure(listFor({ result: 'XIS' }))).code, 'VALIDATION_ERROR');
  await env.decide(A, rec.id, { decision: 'ACCEPT', note: 'ok' });
  assert.ok(!(await listFor({ pending: 'true' })).items.some((r) => r.manualReference === op.manualReference), 'decidida some das pendentes');
});

test('m9d832 serviço de decisão exposto aceita só os valores do livro', { skip: skip() }, async () => {
  assert.equal(typeof decideService.decide, 'function');
  const err = await env.failure(env.decide(A, '00000000-0000-4000-8000-000000000000', { decision: 'ACCEPT', note: 'x' }));
  assert.deepEqual([err.status, err.code], [404, 'GOV_NOT_FOUND']);
});
