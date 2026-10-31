'use strict';

// M9-D907 — relatório de rollback, itens criados pelo rollback de setor (M9-D904) e sua resolução, com a Torre mostrando GOV_ROLLBACK_PENDING. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d907Env');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const ENTITY = 'QA907_ENTITY';
before(async () => { if (env.DISPOSABLE) { A = (await env.loadTenants()).A; await env.cleanup(A); } });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { await env.sequelize.close(); });

/** Após o GO: 3 PIX (R$ 100,00, 250,50 e 49,50) e 120 mensagens, todos da entidade do teste, e o setor ATENDIMENTO com 5% e a entidade do teste. */
async function scenario({ sector = 'ATENDIMENTO' } = {}) {
  await env.listTypes(A);
  await env.adminQuery("UPDATE governance.external_op_types SET entity = $2 WHERE company_id = $1 AND code IN ('PAYMENT_SENT', 'MESSAGE_SENT', 'PUBLICATION_PUBLISHED')", [A.companyId, ENTITY]);
  await env.decide(A, 'GO');
  for (const [i, amountCents] of [10000, 25050, 4950].entries()) await env.record(A, { operation: 'submitPayment', reference: `pix-${i}`, amountCents, dangerous: true });
  const type = (await env.adminQuery("SELECT id FROM governance.external_op_types WHERE company_id = $1 AND code = 'MESSAGE_SENT'", [A.companyId])).rows[0];
  await env.adminQuery(
    `INSERT INTO governance.external_op_log (group_id, company_id, type_id, op_type, reference, executed_at, entity)
     SELECT $1, $2, $3, 'MESSAGE_SENT', 'msg-' || g, now(), $4 FROM generate_series(1, 120) g`, [A.groupId, A.companyId, type.id, ENTITY]
  );
  await env.addSectorUsers(A, sector, 20);
  await env.setEntities(A, sector, [ENTITY]);
  await env.setParam(A, 'migracao.canary.exigir_comparacao', false);
  await env.advance(A, sector);
}
const group = (report, code) => report.groups.find((g) => g.opType === code);

test('m9d907 relatório de rollback lista tudo desde T0, agrupado por tipo, com valor, procedimento e responsável', { skip: skip() }, async () => {
  await scenario();
  await env.record(A, { operation: 'publishPage', reference: 'pagina-1', dangerous: true });
  const rep = await env.getReport(A);
  assert.equal(rep.hasGo, true);
  assert.deepEqual(rep.groups.map((g) => [g.opType, g.count, g.pending, g.compensated]), [['MESSAGE_SENT', 120, 120, 0], ['PAYMENT_SENT', 3, 3, 0], ['PUBLICATION_PUBLISHED', 1, 1, 0]]);
  const pix = group(rep, 'PAYMENT_SENT');
  assert.deepEqual([pix.amountCents, pix.reversibility, pix.owner, pix.module], [40000, 'IRREVERSIBLE', 'Financeiro', 'FINANCE']);
  assert.match(pix.procedure, /estorno/i);
  assert.match(group(rep, 'MESSAGE_SENT').compensation, /corretiva/i);
  assert.deepEqual([rep.totals.operations, rep.totals.pending, rep.totals.amountCents, rep.complete], [124, 124, 40000, false]);
});

test('m9d907 operação anterior ao GO e tipo reversível ficam fora do relatório', { skip: skip() }, async () => {
  await env.listTypes(A);
  const type = (await env.adminQuery("SELECT id FROM governance.external_op_types WHERE company_id = $1 AND code = 'PAYMENT_SENT'", [A.companyId])).rows[0];
  await env.adminQuery("INSERT INTO governance.external_op_log (group_id, company_id, type_id, op_type, reference, executed_at) VALUES ($1, $2, $3, 'PAYMENT_SENT', 'antes', now() - interval '1 day')", [A.groupId, A.companyId, type.id]);
  await env.putTypes(A, [env.goodType('QA907_REV', { reversibility: 'REVERSIBLE', operations: ['qa907Rev'], procedure: '' })]);
  assert.deepEqual((await env.getReport(A)).groups, [], 'sem GO não há relatório');
  await env.decide(A, 'GO');
  await env.record(A, { operation: 'qa907Rev', reference: 'r', dangerous: false });
  await env.record(A, { operation: 'submitPayment', reference: 'depois', dangerous: true });
  const rep = await env.getReport(A);
  assert.deepEqual(rep.groups.map((g) => [g.opType, g.count]), [['PAYMENT_SENT', 1]], 'só o que saiu desde T0 e que precisa de compensação');
});

test('m9d907 rollback de setor cria um item por operação do setor desde T0 e a Torre mostra GOV_ROLLBACK_PENDING até resolvê-los', { skip: skip() }, async () => {
  await scenario();
  assert.equal((await env.towerBlockers(A, 'GOV_ROLLBACK_PENDING')).length, 0, 'antes do rollback não há item nem blocker');
  const out = await env.rollback(A, 'ATENDIMENTO', { reason: 'Divergência no ensaio.' });
  assert.deepEqual([out.previousPercent, out.percent], [5, 0]);
  const itemRows = await env.itemRows(A);
  assert.equal(itemRows.length, 123, '3 pagamentos + 120 mensagens do setor');
  assert.ok(itemRows.every((i) => i.state === 'PENDING_COMPENSATION' && i.sector === 'ATENDIMENTO'));
  const blockers = await env.towerBlockers(A, 'GOV_ROLLBACK_PENDING');
  assert.deepEqual(blockers.map((b) => [b.ref, b.entity, b.detail.count, b.detail.amount_cents]), [['ATENDIMENTO:MESSAGE_SENT', ENTITY, 120, 0], ['ATENDIMENTO:PAYMENT_SENT', ENTITY, 3, 40000]]);
  const audit = (await env.auditOf(A, 'migration.canary.rolled_back')).slice(-1)[0];
  assert.deepEqual(audit.after_json.hooks, ['external-ops']);

  assert.equal((await env.getReport(A)).complete, false);
  const pixItems = (await env.getReport(A, { type: 'PAYMENT_SENT' })).items.rows;
  assert.equal(pixItems.length, 3);
  for (const row of pixItems) await env.resolveItem(A, row.itemId, { note: 'Estorno solicitado ao banco.', compensationRef: `EST-${row.reference}` });
  assert.deepEqual((await env.towerBlockers(A, 'GOV_ROLLBACK_PENDING')).map((b) => b.ref), ['ATENDIMENTO:MESSAGE_SENT'], 'resolvidos os pagamentos, só as mensagens ficam');
  const mid = await env.getReport(A);
  assert.deepEqual([group(mid, 'PAYMENT_SENT').compensated, group(mid, 'PAYMENT_SENT').pending, mid.complete], [3, 0, false]);
  await env.adminQuery("UPDATE governance.rollback_items SET state = 'COMPENSATED', resolved_at = now() WHERE company_id = $1 AND state = 'PENDING_COMPENSATION'", [A.companyId]);
  assert.equal((await env.towerBlockers(A, 'GOV_ROLLBACK_PENDING')).length, 0, 'sem pendências, o blocker fecha');
  const done = await env.getReport(A);
  assert.deepEqual([done.complete, done.totals.pending, done.totals.compensated], [true, 0, 123]);
});

test('m9d907 rollback não conclui com pendências: o relatório só fecha quando nenhuma linha está PENDING_COMPENSATION', { skip: skip() }, async () => {
  await scenario();
  await env.rollback(A, 'ATENDIMENTO', { reason: 'Ensaio.' });
  const rep = await env.getReport(A, { type: 'PAYMENT_SENT' });
  assert.equal(rep.complete, false);
  const [first, ...rest] = rep.items.rows;
  await env.resolveItem(A, first.itemId, {});
  assert.equal((await env.getReport(A)).complete, false, 'ainda há pendências');
  for (const row of rest) await env.resolveItem(A, row.itemId, {});
  const mid = await env.getReport(A);
  assert.equal(mid.complete, false, 'as mensagens seguem pendentes');
  assert.equal(group(mid, 'MESSAGE_SENT').pending, 120);
});

test('m9d907 resolver item já resolvido devolve 409, item desconhecido 404, e repetir o rollback não duplica itens nem inclui outro setor', { skip: skip() }, async () => {
  await scenario();
  await env.rollback(A, 'ATENDIMENTO', { reason: 'Ensaio.' });
  const [row] = (await env.getReport(A, { type: 'PAYMENT_SENT' })).items.rows;
  const ok = await env.resolveItem(A, row.itemId, { note: 'Feito.', compensationRef: 'EST-1' });
  assert.deepEqual([ok.state, ok.compensationRef], ['COMPENSATED', 'EST-1']);
  const again = await env.fail(env.resolveItem(A, row.itemId, {}));
  assert.deepEqual([again.status, again.code, again.message], [409, 'GOV_ROLLBACK_ITEM_FINAL', 'Este item de rollback já foi resolvido.']);
  assert.equal((await env.fail(env.resolveItem(A, '00000000-0000-4000-8000-000000000907'))).status, 404);
  assert.equal((await env.fail(env.resolveItem(A, 'não-é-uuid'))).status, 404);
  await env.record(A, { operation: 'sendEmail', reference: 'outro-setor', entity: 'QA907_OUTRA', dangerous: false });
  const blocked = await env.fail(env.advance(A, 'ATENDIMENTO'));
  assert.deepEqual([blocked.status, blocked.code], [409, 'GOV_CANARY_BLOCKERS_OPEN'], 'compensação pendente trava o setor de subir de novo');
  await env.adminQuery("UPDATE governance.rollback_items SET state = 'COMPENSATED', resolved_at = now() WHERE company_id = $1 AND id <> $2", [A.companyId, row.itemId]);
  await env.advance(A, 'ATENDIMENTO');
  await env.rollback(A, 'ATENDIMENTO', { reason: 'De novo.' });
  assert.equal((await env.itemRows(A)).length, 123, 'o mesmo registro não gera dois itens e a operação de outra entidade fica fora');
  assert.equal((await env.itemRows(A)).filter((i) => i.state === 'COMPENSATED').length, 123, 'itens resolvidos seguem resolvidos');
  const audit = (await env.auditOf(A, 'migration.rollback_item.resolved')).slice(-1)[0];
  assert.deepEqual([audit.entity_id, audit.after_json.state], [row.itemId, 'COMPENSATED']);
});

test('m9d907 resolver o mesmo item ao mesmo tempo: só uma chamada passa', { skip: skip() }, async () => {
  await scenario();
  await env.rollback(A, 'ATENDIMENTO', { reason: 'Ensaio.' });
  const [row] = (await env.getReport(A, { type: 'PAYMENT_SENT' })).items.rows;
  const results = await Promise.all([env.fail(env.resolveItem(A, row.itemId, {})), env.fail(env.resolveItem(A, row.itemId, {}))]);
  assert.deepEqual(results.map((r) => (r ? r.status : 200)).sort(), [200, 409]);
});

test('m9d907 envio que nunca saiu (cancelado) não gera item nem entra no relatório', { skip: skip() }, async () => {
  await scenario();
  const bank = await env.connection(A, 'BANK');
  const sent = await env.sendDispatch(A, bank.id, 'submitPayment', `qa907-cancel-${Date.now()}`, { amount: '77.00' });
  assert.equal(group(await env.getReport(A), 'PAYMENT_SENT').count, 4);
  await env.adminQuery("UPDATE integration.dispatches SET status = 'CANCELLED' WHERE id = $1", [sent.dispatch.id]);
  assert.equal(group(await env.getReport(A), 'PAYMENT_SENT').count, 3);
  await env.rollback(A, 'ATENDIMENTO', { reason: 'Ensaio.' });
  assert.equal((await env.itemRows(A)).length, 123);
});
