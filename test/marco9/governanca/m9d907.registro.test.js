'use strict';

// M9-D907 — registro das operações externas a partir de T0 (o GO): pelo caminho de produção (createDispatch), na mesma transação do envio, e o envio que não sai sem o registro.
// Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d907Env');
const logRepo = require('../../../src/features/migration-v2/rollback/log.repository');

let A; let bank; let msg;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const key = (n) => `qa907-${n}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
before(async () => {
  if (!env.DISPOSABLE) return;
  A = (await env.loadTenants()).A;
  await env.cleanup(A);
  bank = await env.connection(A, 'BANK');
  msg = await env.connection(A, 'MESSAGING');
});
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { await env.sequelize.close(); });

const dispatchCount = async (k) => Number((await env.adminQuery('SELECT count(*) AS n FROM integration.dispatches WHERE company_id = $1 AND idempotency_key = $2', [A.companyId, k])).rows[0].n);

test('m9d907 antes do GO nenhuma operação é registrada; depois do GO, o envio de pagamento vira registro com valor em centavos', { skip: skip() }, async () => {
  const pre = await env.sendDispatch(A, bank.id, 'submitPayment', key('pre'), { amount: '10.00' });
  assert.equal(pre.created, true);
  assert.equal((await env.logRows(A)).length, 0, 'sem T0 não há o que registrar');
  const go = await env.decide(A, 'GO');
  const k = key('pix');
  const sent = await env.sendDispatch(A, bank.id, 'submitPayment', k, { amount: '1234.56' }, { aggregateId: '11111111-1111-4111-8111-111111111111' });
  const rows = await env.logRows(A);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].op_type, rows[0].dispatch_id, rows[0].reference, Number(rows[0].amount_cents), rows[0].entity], ['PAYMENT_SENT', sent.dispatch.id, '11111111-1111-4111-8111-111111111111', 123456, 'FINANCIAL_ENTRY']);
  assert.ok(new Date(rows[0].executed_at) >= new Date(go.t0), 'executed_at depois de T0');
});

test('m9d907 mensagens entram no registro, consulta não, e repetir o envio idempotente não duplica', { skip: skip() }, async () => {
  await env.decide(A, 'GO');
  const k = key('msg');
  await env.sendDispatch(A, msg.id, 'sendText', k, { to: 'x', text: 'oi' }, { criticalityOp: 'SAFE' });
  const again = await env.sendDispatch(A, msg.id, 'sendText', k, { to: 'x', text: 'oi' }, { criticalityOp: 'SAFE' });
  assert.equal(again.created, false);
  await env.sendDispatch(A, msg.id, 'getStatus', key('st'), { id: 'x' }, { criticalityOp: 'SAFE' });
  const rows = await env.logRows(A);
  assert.deepEqual(rows.map((r) => r.op_type), ['MESSAGE_SENT']);
});

test('m9d907 operação perigosa que nenhum tipo cobre cria o tipo sem plano, abre o blocker e o plano cadastrado o fecha', { skip: skip() }, async () => {
  await env.decide(A, 'GO');
  await env.sendDispatch(A, bank.id, 'qa907NovaOperacao', key('nova'), { amount: '5.00' });
  const types = (await env.listTypes(A)).types;
  const auto = types.find((t) => t.code === 'UNMAPPED_QA907_NOVA_OPERACAO');
  assert.deepEqual([auto.reversibility, auto.compensation, auto.owner, auto.operations], ['IRREVERSIBLE', '', '', ['qa907NovaOperacao']]);
  const open = await env.towerBlockers(A, 'GOV_ROLLBACK_COMPENSATION_REQUIRED');
  assert.deepEqual(open.map((b) => b.ref), ['type:UNMAPPED_QA907_NOVA_OPERACAO']);
  assert.equal((await env.logRows(A)).length, 1, 'a operação foi registrada mesmo sem plano');
  await env.putTypes(A, [env.goodType('UNMAPPED_QA907_NOVA_OPERACAO', { entity: null })]);
  assert.equal((await env.towerBlockers(A, 'GOV_ROLLBACK_COMPENSATION_REQUIRED')).length, 0);
});

test('m9d907 operação externa sem log é bloqueada: se o registro falha, o envio não é criado', { skip: skip() }, async () => {
  await env.decide(A, 'GO');
  const original = logRepo.insert;
  logRepo.insert = async () => { throw new Error('disco cheio'); };
  const k = key('semlog');
  try {
    const err = await env.fail(env.sendDispatch(A, bank.id, 'submitPayment', k, { amount: '9.99' }));
    assert.deepEqual([err.status, err.code, err.message], [503, 'GOV_ROLLBACK_LOG_FAILED', 'Não foi possível registrar a operação externa; ela não foi enviada.']);
  } finally { logRepo.insert = original; }
  assert.equal(await dispatchCount(k), 0, 'o envio foi desfeito junto');
  assert.equal((await env.logRows(A)).length, 0);
  await env.sendDispatch(A, bank.id, 'submitPayment', k, { amount: '9.99' });
  assert.equal(await dispatchCount(k), 1);
  assert.equal((await env.logRows(A)).length, 1, 'com o registro funcionando, o mesmo envio sai e é registrado');
});

test('m9d907 NO_GO encerra o T0: depois dele nada é registrado até um novo GO', { skip: skip() }, async () => {
  await env.decide(A, 'GO');
  await env.sendDispatch(A, bank.id, 'submitPayment', key('a'), { amount: '1.00' });
  await env.decide(A, 'NO_GO', { reason: 'Voltar atrás.' });
  await env.sendDispatch(A, bank.id, 'submitPayment', key('b'), { amount: '2.00' });
  assert.equal((await env.logRows(A)).length, 1);
  const regained = await env.decide(A, 'GO');
  await env.sendDispatch(A, bank.id, 'submitPayment', key('c'), { amount: '3.00' });
  const rows = await env.logRows(A);
  assert.equal(rows.length, 2);
  assert.ok(new Date(rows[1].executed_at) >= new Date(regained.t0));
});
