'use strict';

// M9-D833 — dupla checagem do pagamento manual emergencial, pela guarda da importação (serviço, banco descartável). checker_1 = quem registrou; checker_2 = quem importa, com governance:bcp:approve.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d833Env');

const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
let A;
let B;
let ctx;
let maker;
let restore;
const refusal = (item) => ({ code: item.error && item.error.code, message: item.error && item.error.message });

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A, B } = await env.loadTenants());
  restore = await env.prepare833(A);
  ctx = await env.context(A);
  maker = await env.otherUserId();
});
after(async () => { if (env.DISPOSABLE) { await env.clean833(); await restore(); await env.sequelize.close(); } });

test('m9d833 pagamento manual sem segunda checagem é recusado', { skip: skip() }, async () => {
  const op = await env.recordPayment(A, ctx, { conferente2: undefined, conferente2DataHora: undefined });
  const item = (await env.importIds(A, [op.id])).items[0];
  assert.equal(item.error.code, 'GOV_BCP_PAYLOAD_INVALID', 'o formulário sem o segundo conferente não passa pela validação do modelo');
  assert.equal((await env.entriesOf(op.manualReference)).length, 0, 'nenhum lançamento a pagar');
  assert.equal((await env.opRow(op.id)).status, 'RECORDED');
});

test('m9d833 mesma pessoa nas duas checagens recusada', { skip: skip() }, async () => {
  const op = await env.recordPayment(A, ctx, {}, { actorUserId: A.userId });
  const item = (await env.importIds(A, [op.id], A.userId)).items[0];
  assert.deepEqual(refusal(item), { code: 'GOV_BCP_PAYMENT_SAME_PERSON', message: 'As duas conferências devem ser de pessoas diferentes.' });
  assert.equal((await env.entriesOf(op.manualReference)).length, 0, 'recusa sem criar o lançamento');
  assert.equal((await env.checksOf(op.id)).filter((c) => c.role === 'CHECKER_2').length, 0, 'a segunda checagem não fica gravada');
  assert.equal((await env.opRow(op.id)).status, 'RECORDED');
  assert.equal(await env.importRow(op.id), null);
});

test('m9d833 checker_2 sem governance:bcp:approve devolve 403', { skip: skip() }, async () => {
  const op = await env.recordPayment(A, ctx, {}, { actorUserId: A.userId });
  const err = await env.failure(env.importIds(A, [op.id], maker));
  assert.deepEqual([err.status, err.code, err.message], [403, 'PERMISSION_DENIED', 'Permissão ausente: governance:bcp:approve.']);
  assert.equal((await env.entriesOf(op.manualReference)).length, 0);
  assert.equal(await env.importRow(op.id), null);
});

test('m9d833 conferentes do papel iguais devolvem 422 GOV_BCP_PAYMENT_DOUBLE_CHECK', { skip: skip() }, async () => {
  for (const over of [{ conferente2: '  ana   QA ' }, { conferente2: 'ANA qa' }, { conferente2: 'Aná QA' }]) {
    const op = await env.recordPayment(A, ctx, over);
    const item = (await env.importIds(A, [op.id])).items[0];
    assert.deepEqual(refusal(item), { code: 'GOV_BCP_PAYMENT_DOUBLE_CHECK', message: 'Pagamento manual exige conferência por duas pessoas diferentes.' }, JSON.stringify(over));
    assert.equal((await env.entriesOf(op.manualReference)).length, 0);
  }
});

test('m9d833 duas pessoas distintas: R$ 12.000,00 aceito, checagens gravadas com data e hora e auditadas', { skip: skip() }, async () => {
  const op = await env.recordPayment(A, ctx, { valorCentavos: 1200000 });
  const before1 = await env.checksOf(op.id);
  assert.deepEqual(before1.map((c) => [c.role, c.user_id]), [['CHECKER_1', maker]], 'checker_1 gravado no registro');
  const item = (await env.importIds(A, [op.id])).items[0];
  assert.equal(item.error, null, JSON.stringify(item.error));
  const checks = await env.checksOf(op.id);
  assert.deepEqual(checks.map((c) => [c.role, c.user_id]), [['CHECKER_1', maker], ['CHECKER_2', A.userId]]);
  assert.ok(checks.every((c) => c.at instanceof Date), 'data e hora de cada checagem');
  assert.equal(checks[0].at.getTime(), (await env.opRow(op.id)).recorded_at.getTime(), 'checker_1 vale desde o registro');
  assert.equal((await env.auditOf(A, 'bcp.payment.checked')).filter((a) => a.entity_id === op.id).length, 2, 'uma auditoria por checagem');
});

test('m9d833 importação duas vezes não paga duas vezes', { skip: skip() }, async () => {
  const op = await env.recordPayment(A, ctx);
  const first = (await env.importIds(A, [op.id])).items[0];
  const second = (await env.importIds(A, [op.id])).items[0];
  assert.deepEqual([first.error, second.error, second.alreadyImported], [null, null, true]);
  assert.equal((await env.entriesOf(op.manualReference)).length, 1, 'um só lançamento');
  assert.equal((await env.checksOf(op.id)).length, 2, 'duas checagens, sem repetir');
  assert.ok(await env.pendingOf(op.id), 'uma pendência de conciliação');
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.bcp_payment_pendings WHERE manual_operation_id = $1', [op.id])).rows[0].n, 1);
});

test('m9d833 isolamento entre empresas: a outra empresa não enxerga checagens nem pendências', { skip: skip() }, async () => {
  const op = await env.recordPayment(A, ctx);
  await env.importIds(A, [op.id]);
  const seen = await env.inTx(B, async (tx) => {
    const [checks] = await env.sequelize.query('SELECT count(*)::int AS n FROM governance.manual_operation_checks', { transaction: tx });
    const [pend] = await env.sequelize.query('SELECT count(*)::int AS n FROM governance.bcp_payment_pendings', { transaction: tx });
    return [checks[0].n, pend[0].n];
  }, B.userId);
  assert.deepEqual(seen, [0, 0]);
});

test('m9d833 outras ações não passam pela dupla checagem', { skip: skip() }, async () => {
  const op = await env.recordAction(A, 'REGISTER_LEAD', ctx, {}, { actorUserId: A.userId });
  const item = (await env.importIds(A, [op.id], A.userId)).items[0];
  assert.equal(item.error, null);
  assert.deepEqual(await env.checksOf(op.id), []);
});
