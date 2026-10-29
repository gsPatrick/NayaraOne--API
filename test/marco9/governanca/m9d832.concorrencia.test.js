'use strict';

// M9-D832 — dois imports simultâneos da mesma referência executam o comando uma vez só (FOR UPDATE na operação + UNIQUE da importação). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d832Env');

const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
let A;
let ctx;

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A } = await env.loadTenants());
  await env.prepare(A);
  ctx = await env.context(A);
});
after(async () => { if (env.DISPOSABLE) { await env.cleanImports(); await env.sequelize.close(); } });

test('m9d832 dois imports simultâneos: um executa, o outro devolve a resposta do primeiro', { skip: skip() }, async () => {
  for (const action of ['RECEIVE_PAYMENT', 'EMERGENCY_PAYMENT', 'REGISTER_LEAD']) {
    const op = await env.recordAction(A, action, ctx, action === 'RECEIVE_PAYMENT' ? { referenciaParcela: await require('../_helpers/m9d832More').createReceivable(A, ctx.base, 1205) } : {});
    const [one, two] = await Promise.all([env.importIds(A, [op.id]), env.importIds(A, [op.id])]);
    const items = [one.items[0], two.items[0]];
    assert.deepEqual(items.map((i) => i.error), [null, null], action);
    assert.equal(items.filter((i) => i.alreadyImported).length, 1, `${action}: exatamente uma resposta é a repetida`);
    assert.equal(items[0].commandRef, items[1].commandRef);
    assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.manual_operation_imports WHERE manual_operation_id = $1', [op.id])).rows[0].n, 1);
    assert.equal((await env.outbox(`bcp.manual_operation.imported:${A.companyId}:${op.manualReference}`)).length, 1, `${action}: um evento`);
    if (action === 'EMERGENCY_PAYMENT') assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM finance.financial_entries WHERE origin_ref = $1', [`bcp:${op.manualReference}`])).rows[0].n, 1, 'um só lançamento a pagar');
  }
});
