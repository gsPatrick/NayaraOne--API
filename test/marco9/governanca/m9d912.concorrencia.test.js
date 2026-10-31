'use strict';

// M9-D912 §6 — concorrência: a checagem da disposição e a criação da retenção se serializam pela trava da empresa (a disposição toma a compartilhada e a criação, a exclusiva).
// Quem chega depois enxerga o que o outro confirmou. Banco descartável (transações com commit real, de verdade em paralelo).
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d912Env');

let tenants;
const A = () => tenants.A;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.resetHolds(A()); env.useRealGuard(); } });
afterEach(async () => { if (env.DISPOSABLE) await env.resetHolds(A()); });
after(async () => { await env.sequelize.close(); });

test('m9d912 retenção criada enquanto a exclusão está em curso espera a exclusão terminar; a exclusão seguinte já a enxerga', { skip: env.skip() }, async () => {
  const person = await env.insertPerson(A());
  const events = [];
  const disposal = env.withTx(A(), async (tx) => {
    await env.guard.assertNotOnHold('PERSON', person, tx, A()); // passa: ainda não há retenção
    events.push('exclusão verificou');
    await sleep(700); // a exclusão segue em curso (ainda não confirmou)
    await env.adminQuery('SELECT 1');
    events.push('exclusão confirmou');
  });
  await sleep(150);
  const creation = env.createHold(A(), { scope: [{ type: 'PERSON', id: person }] }).then((hold) => { events.push('retenção criada'); return hold; });
  await Promise.all([disposal, creation]);
  assert.deepEqual(events, ['exclusão verificou', 'exclusão confirmou', 'retenção criada'], 'a criação esperou a exclusão em curso');
  await assert.rejects(env.assertNotOnHold(A(), 'PERSON', person), (err) => err.code === 'GOV_HOLD_BLOCKS_DISPOSAL');
});

test('m9d912 exclusão que começa enquanto a retenção está sendo criada espera, enxerga a retenção e é recusada', { skip: env.skip() }, async () => {
  const person = await env.insertPerson(A());
  const events = [];
  const creation = env.withTx(A(), async (tx) => {
    const hold = await env.holds.create(A(), { userId: A().userId, roles: [] }, { code: env.code('RACE'), reason: 'QA-M9 corrida', matter_ref: '0000001-00.2026.8.26.0000', scope: [{ type: 'PERSON', id: person }] }, tx);
    events.push('retenção criada');
    await sleep(700); // ainda sem commit
    events.push('retenção confirmada');
    return hold;
  });
  await sleep(150);
  const disposal = env.assertNotOnHold(A(), 'PERSON', person).then(() => events.push('exclusão passou'), (err) => events.push(`exclusão recusada ${err.code}`));
  await Promise.all([creation, disposal]);
  assert.deepEqual(events, ['retenção criada', 'retenção confirmada', 'exclusão recusada GOV_HOLD_BLOCKS_DISPOSAL']);
});

test('m9d912 duas criações simultâneas com o mesmo código: uma vence e a outra recebe 409 GOV_HOLD_CODE_DUPLICATE', { skip: env.skip() }, async () => {
  const person = await env.insertPerson(A());
  const c = env.code('SIM');
  const results = await Promise.allSettled([1, 2, 3].map(() => env.createHold(A(), { code: c, scope: [{ type: 'PERSON', id: person }] })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual([...new Set(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code))], ['GOV_HOLD_CODE_DUPLICATE']);
});
