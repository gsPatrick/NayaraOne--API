'use strict';

// M9-D617 — números de vistorias e chaves, chamados, satisfação e repasses da locação, calculados pelo worker (uma empresa nova por execução).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biEnv');

const { src, apply, makeEvent, rows, pick, setSetting } = bi;
let env;
before(async () => { env = await bi.setup(); });
after(() => bi.teardown(env));

const iso = (date, time = '15:00:00') => `${date}T${time}Z`;

test('m9d617 vistorias pendentes e concluídas, chaves entregues e atrasadas', async () => {
  const c1 = await src.contract(env, env.cX, { status: 'ACTIVE', startsAt: iso('2026-09-01') });
  const c2 = await src.contract(env, env.cX, { status: 'SIGNED', startsAt: iso('2026-11-15') });
  const sale = await src.contract(env, env.cX, { type: 'SALE', status: 'ACTIVE' });
  for (const status of ['SCHEDULED', 'COMPLETED', 'COMPLETED', 'CANCELLED']) await src.inspection(env, env.cX, { contract: c1, status });
  await src.inspection(env, env.cX, { contract: sale, status: 'SCHEDULED' });
  const released = await src.keyDelivery(env, env.cX, { contract: c1, status: 'RELEASED' });
  await src.keyDelivery(env, env.cX, { contract: c1, status: 'PENDING' }); // contrato já começou: atrasada
  await src.keyDelivery(env, env.cX, { contract: c2, status: 'PENDING' }); // começa só em novembro
  await src.keyDelivery(env, env.cX, { contract: c1, status: 'CANCELLED' });
  await apply(env.cX, makeEvent(env.cX, 'legal.key_delivery.released', { id: released }));
  const [r] = await rows(env, 'rm_rental_inspections_keys', env.cX);
  assert.deepEqual([r.inspections_pending, r.inspections_done, r.keys_out, r.keys_overdue], [1, 2, 1, 1]);
});

test('m9d617 chamados abertos e fechados no dia, em aberto e horas de resolução', async () => {
  const property = src.uuid();
  await src.contract(env, env.cX, { status: 'ACTIVE', property });
  const m = (c) => src.maintenance(env, env.cX, { property, ...c });
  const today = await m({ status: 'OPEN', created: iso('2026-10-28', '13:00:00') });
  await m({ status: 'OPEN', created: iso('2026-10-20') });
  await m({ status: 'CLOSED', created: iso('2026-10-28', '10:00:00'), updated: iso('2026-10-28', '14:00:00') });
  await m({ status: 'RESOLVED', created: iso('2026-10-26'), updated: iso('2026-10-27') });
  await src.maintenance(env, env.cX, { property: src.uuid(), status: 'OPEN', created: iso('2026-10-28') }); // imóvel sem locação
  await apply(env.cX, makeEvent(env.cX, 'warranty.case.opened', { id: today }));
  const [r] = await rows(env, 'rm_rental_tickets', env.cX);
  assert.deepEqual([r.opened, r.closed, r.open_total, r.resolution_hours_sum], [2, 1, 2, '4.00']);
});

test('m9d617 satisfação por mês com a nota de cada tipo vinda do parâmetro', async () => {
  const [tenant, buyer] = [src.uuid(), src.uuid()];
  await src.party(env, env.cX, { contract: await src.contract(env, env.cX, { status: 'ACTIVE' }), person: tenant });
  await src.party(env, env.cX, { contract: await src.contract(env, env.cX, { type: 'SALE', status: 'ACTIVE' }), person: buyer });
  const f = (person, type, day) => src.feedback(env, env.cX, { person, type, created: iso(day) });
  const first = await f(tenant, 'COMPLIMENT', '2026-10-05');
  await f(tenant, 'COMPLAINT', '2026-10-06');
  await f(tenant, 'CONFLICT', '2026-10-07');
  await f(buyer, 'COMPLAINT', '2026-10-08'); // comprador não é locatário
  await f(tenant, 'COMPLIMENT', '2026-09-05');
  await apply(env.cX, makeEvent(env.cX, 'crm.feedback_case.created', { id: first }));
  let oct = pick(await rows(env, 'rm_rental_satisfaction', env.cX), { month: '2026-10' });
  assert.deepEqual([oct.responses, oct.score_sum], [3, 9], 'elogio 5 + reclamação 1 + conflito 3');
  assert.equal(pick(await rows(env, 'rm_rental_satisfaction', env.cX), { month: '2026-09' }), undefined, 'setembro só entra quando algo o recalcula');
  await setSetting(env, env.cX, 'analytics.locacao.nota_conflito', 0);
  await apply(env.cX, makeEvent(env.cX, 'crm.feedback_case.resolved', { id: first }));
  oct = pick(await rows(env, 'rm_rental_satisfaction', env.cX), { month: '2026-10' });
  assert.deepEqual([oct.responses, oct.score_sum], [3, 6], 'nota do conflito vem do parâmetro');
});

test('m9d617 repasses pendentes, pagos no mês e vencidos pelo prazo configurável', async () => {
  const r = (c) => src.repass(env, env.cX, c);
  const first = await r({ amount: '1000.00', month: '2026-09' }); // vence em 30/09 + 10 = 10/10
  await r({ amount: '2000.00', month: '2026-10' }); // vence em 31/10 + 10
  await r({ amount: '500.00', month: '2026-08', status: 'APPROVED' });
  await r({ amount: '800.00', month: '2026-09', status: 'PAID', paidAt: iso('2026-10-15') });
  await r({ amount: '700.00', month: '2026-08', status: 'PAID', paidAt: iso('2026-09-15') });
  await r({ amount: '600.00', month: '2026-08', status: 'CANCELLED' });
  await apply(env.cX, makeEvent(env.cX, 'finance.owner_repasse.created', { id: first }));
  const row = async () => (await rows(env, 'rm_rental_repasses', env.cX))[0];
  let v = await row();
  assert.deepEqual([v.pending, v.overdue, v.paid, v.pending_count, v.overdue_count, v.paid_count], ['3500.00', '1500.00', '800.00', 3, 2, 1]);
  await setSetting(env, env.cX, 'analytics.locacao.repasse_prazo_dias', 30);
  await apply(env.cX, makeEvent(env.cX, 'finance.owner_repass.completed', { id: first }));
  v = await row();
  assert.deepEqual([v.overdue, v.overdue_count], ['500.00', 1], 'com prazo de 30 dias o repasse de setembro ainda não venceu');
});
