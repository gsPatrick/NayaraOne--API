'use strict';

// M9-D617 — números de contratos, vacância, inadimplência, garantias e obrigações da locação, calculados pelo worker (uma empresa nova por execução).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biEnv');

const { src, apply, makeEvent, rows, setSetting } = bi;
let env;
before(async () => { env = await bi.setup(); });
after(() => bi.teardown(env));

const iso = (date, time = '15:00:00') => `${date}T${time}Z`;
const statusEvent = (id) => makeEvent(env.cX, 'legal.contract.status_changed', { id, fromStatus: 'SIGNED', toStatus: 'ACTIVE' });
const entryEvent = (id) => makeEvent(env.cX, 'finance.entry.settled', { id });

test('m9d617 contratos de locação por situação, com o valor, e os tipos vindos do parâmetro', async () => {
  const mk = (type, status, value) => src.contract(env, env.cX, { type, status, value });
  const first = await mk('LEASE', 'ACTIVE', '3000.00');
  await mk('LEASE_RESIDENTIAL', 'ACTIVE', '2500.00');
  await mk('PROPERTY_ADMIN', 'ACTIVE', '1000.00');
  await mk('LEASE', 'SUSPENDED', '800.00');
  await mk('SALE', 'ACTIVE', '900000.00');
  await apply(env.cX, statusEvent(first));
  let list = await rows(env, 'rm_rental_contracts', env.cX);
  assert.deepEqual(list.map((r) => [r.status, r.count, r.rent_total]), [['ACTIVE', 3, '6500.00'], ['SUSPENDED', 1, '800.00']], 'venda fica de fora; suspenso conta à parte');
  await setSetting(env, env.cX, 'analytics.locacao.tipos_contrato', 'LEASE');
  await apply(env.cX, statusEvent(first));
  list = await rows(env, 'rm_rental_contracts', env.cX);
  assert.deepEqual(list.map((r) => [r.status, r.count, r.rent_total]), [['ACTIVE', 1, '3000.00'], ['SUSPENDED', 1, '800.00']], 'tipos de contrato configuráveis');
});

test('m9d617 vacância: locáveis, alugados, suspensos, vagos e dias vagos', async () => {
  const p = (status, extra = {}) => src.property(env, env.cX, { status, created: iso('2026-09-28'), ...extra });
  const withOffer = async (prop) => { await src.offer(env, env.cX, { property: prop, type: 'RENT' }); return prop; };
  const vacant = await withOffer(await p('AVAILABLE')); // cadastro em 28/09: 30 dias
  const rented = await p('RENTED');
  await src.contract(env, env.cX, { status: 'ACTIVE', property: rented });
  const suspended = await withOffer(await p('AVAILABLE'));
  await src.contract(env, env.cX, { status: 'SUSPENDED', property: suspended });
  const inWorks = await withOffer(await p('AVAILABLE'));
  await src.project(env, env.cX, { property: inWorks, status: 'ACTIVE' });
  await p('AVAILABLE'); // sem oferta de locação nem contrato: não é locável
  await withOffer(await p('WITHDRAWN'));
  await withOffer(await p('AVAILABLE', { publication: 'INACTIVE' }));
  const reRent = await withOffer(await p('AVAILABLE'));
  await src.contract(env, env.cX, { status: 'TERMINATED', property: reRent, endsAt: iso('2026-10-18') }); // vago há 10 dias
  await apply(env.cX, makeEvent(env.cX, 'property.created', { id: vacant }));
  const [row] = await rows(env, 'rm_rental_vacancy', env.cX);
  assert.deepEqual([row.as_of_date, row.rentable_total, row.rented_total, row.suspended_total, row.vacant_total, Number(row.vacant_days_sum)], ['2026-10-28', 4, 1, 1, 2, 40]);
});

test('m9d617 inadimplência pelo ledger, com a janela do Financeiro configurável', async () => {
  const lease = await src.contract(env, env.cX, { status: 'ACTIVE' });
  const sale = await src.contract(env, env.cX, { type: 'SALE', status: 'ACTIVE' });
  const e = (c) => src.entry(env, env.cX, { contract: lease, ...c });
  await e({ amount: '1000.00', due: iso('2026-10-10') });
  await e({ amount: '200.00', due: iso('2026-09-20') });
  await e({ amount: '500.00', due: iso('2026-06-01') });
  await e({ amount: '700.00', due: iso('2026-11-05') }); // a vencer
  await e({ amount: '300.00', due: iso('2026-10-05'), status: 'SETTLED' });
  await e({ amount: '999.00', due: iso('2026-10-01'), third: true }); // dinheiro de terceiros
  await e({ amount: '50.00', due: iso('2026-10-02'), status: 'REVERSED' });
  await src.entry(env, env.cX, { contract: sale, amount: '4000.00', due: iso('2026-10-01') }); // venda
  await apply(env.cX, entryEvent(await e({ amount: '1.00', due: iso('2026-11-20') })));
  const row = async () => (await rows(env, 'rm_rental_arrears', env.cX))[0];
  let r = await row();
  assert.deepEqual([r.overdue_amount, r.overdue_amount_in_window_90d, r.overdue_amount_outside_window_90d, r.overdue_count, r.billed_90d], ['1700.00', '1200.00', '500.00', 3, '1500.00'],
    'vencido total = dentro + fora da janela de 90 dias; faturado na janela não conta o estornado, o de terceiros nem o que vence depois de hoje');
  await setSetting(env, env.cX, 'analytics.inadimplencia.janela_dias', 30);
  await apply(env.cX, entryEvent(await e({ amount: '2.00', due: iso('2026-12-20') })));
  r = await row();
  assert.deepEqual([r.overdue_amount, r.overdue_amount_in_window_90d, r.overdue_amount_outside_window_90d], ['1700.00', '1000.00', '700.00'], 'janela de 30 dias separa 20/09 do restante; o total não muda');
});

test('m9d617 garantias vencendo em 30 e 60 dias e vencidas, só de contratos em vigor', async () => {
  const lease = await src.contract(env, env.cX, { status: 'ACTIVE' });
  const ended = await src.contract(env, env.cX, { status: 'TERMINATED' });
  const g = (type, endsAt, extra = {}) => src.guarantee(env, env.cX, { contract: lease, type, endsAt, ...extra });
  const first = await g('GUARANTOR', '2026-11-10'); // 13 dias
  await g('GUARANTOR', '2026-10-28'); // vence hoje: conta como vencendo
  await g('GUARANTOR', '2026-10-20'); // vencida
  await g('GUARANTOR', '2026-11-10', { status: 'RELEASED' });
  await g('INSURANCE', '2026-12-20'); // 53 dias
  await g('DEPOSIT', null);
  await src.guarantee(env, env.cX, { contract: ended, type: 'GUARANTOR', endsAt: '2026-11-10' });
  await apply(env.cX, makeEvent(env.cX, 'legal.guarantee.created', { id: first }));
  const list = await rows(env, 'rm_rental_guarantees', env.cX);
  assert.deepEqual(list.map((r) => [r.type, r.expiring_30d, r.expiring_60d, r.expired]), [['GUARANTOR', 2, 2, 1], ['INSURANCE', 0, 1, 0]]);
});

test('m9d617 obrigações pendentes e vencidas por tipo', async () => {
  const active = await src.contract(env, env.cX, { status: 'ACTIVE' });
  const signed = await src.contract(env, env.cX, { status: 'SIGNED' });
  const ended = await src.contract(env, env.cX, { status: 'TERMINATED' });
  await src.requirement(env, env.cX, { contract: active });
  await src.requirement(env, env.cX, { contract: active });
  await src.requirement(env, env.cX, { contract: active, status: 'SATISFIED' });
  await src.requirement(env, env.cX, { contract: signed });
  await src.requirement(env, env.cX, { contract: ended });
  await src.utility(env, env.cX, { contract: active });
  await src.utility(env, env.cX, { contract: active, evidence: src.uuid() });
  await apply(env.cX, statusEvent(active));
  const list = await rows(env, 'rm_rental_obligations', env.cX);
  assert.deepEqual(list.map((r) => [r.kind, r.pending, r.overdue]), [['REQUIREMENT', 3, 2], ['UTILITY', 1, 1]]);
});
