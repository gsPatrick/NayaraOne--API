'use strict';

// M9-D907 — isolamento entre empresas (RLS) das quatro tabelas da demanda. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d907Env');

let A; let B;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { ({ A, B } = await env.loadTenants()); await env.cleanup(A); await env.cleanup(B); } });
afterEach(async () => { if (env.DISPOSABLE) { await env.cleanup(A); await env.cleanup(B); } });
after(async () => { await env.sequelize.close(); });

test('m9d907 isolamento entre empresas: inventário, GO, registro, relatório e itens são de cada empresa', { skip: skip() }, async () => {
  await env.putTypes(A, [env.goodType('QA907_SO_DA_A', { operations: ['qa907SoA'] })]);
  await env.decide(A, 'GO');
  await env.record(A, { operation: 'submitPayment', reference: 'pix-a', amountCents: 500, dangerous: true });
  assert.ok((await env.listTypes(A)).types.some((t) => t.code === 'QA907_SO_DA_A'));
  assert.ok(!(await env.listTypes(B)).types.some((t) => t.code === 'QA907_SO_DA_A'), 'o inventário da B não vê o tipo da A');
  const reportB = await env.getReport(B);
  assert.deepEqual([reportB.hasGo, reportB.groups], [false, []]);
  assert.equal(await env.record(B, { operation: 'submitPayment', reference: 'pix-b', dangerous: true }), null, 'o GO da A não vale para a B: nada é registrado');
  assert.equal((await env.logRows(B)).length, 0);
  const [log] = await env.logRows(A);
  const foreign = await env.fail(env.resolveItem(B, log.id));
  assert.equal(foreign.status, 404, 'item (ou id) de outra empresa é 404');
  for (const table of ['external_op_types', 'external_op_log', 'rollback_items', 'cutover_decisions']) {
    const rows = await env.tx(B, (tn, t) => t.sequelize.query(`SELECT count(*)::int AS n FROM governance.${table} WHERE company_id = :a`, { replacements: { a: A.companyId }, type: 'SELECT', transaction: t }));
    assert.equal(rows[0].n, 0, `RLS de governance.${table}`);
  }
  assert.equal((await env.towerBlockers(B, 'GOV_ROLLBACK_PENDING')).length, 0);
});
