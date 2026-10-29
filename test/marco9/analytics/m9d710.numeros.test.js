'use strict';

// M9-D710 — os três KPIs de fatos do dia refeitos do zero só com os registros-fonte (contratos e assinaturas, oportunidades e propostas, lançamentos), o limiar inclusivo lido do
// parâmetro, o dinheiro de terceiros à parte, o fuso de São Paulo e a oportunidade sem proposta aceita. Relógio fixo em 28/10/2026 12:00 de São Paulo. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d710Env');
const sc = require('../_helpers/m9d710Scenario');
const oracle = require('../_helpers/m9d710Oracle');

const WINDOW = oracle.windowEndingAt(oracle.BASE_NOW, 24);
let env;
before(async () => {
  env = await kit.setup();
  await sc.contratos(env, env.cX);
  await sc.oportunidades(env, env.cX);
  await sc.pagamentos(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

// o snapshot guarda o número com mais casas (numeric); o valor em reais é comparado como número exato de centavos
const dim = async (t, code, key) => { const v = await kit.dimension(t, code, key); return v === null ? null : Number(v).toFixed(String(v).includes('.') && Number(v) % 1 !== 0 ? 2 : 0); };
const money = async (t, code, key) => { const v = await kit.dimension(t, code, key); return v === null ? null : Number(v).toFixed(2); };

test('m9d710 reproduz legal.contracts_signed a partir dos registros-fonte', async () => {
  const want = await oracle.contractsFromSource(env, env.cX, WINDOW);
  assert.equal(want.count, 3, 'duas na janela de ontem e hoje e a das 23:30 de São Paulo; a de um segundo antes da janela e o rascunho ficam de fora');
  assert.equal(want.amount, '482500.00');
  assert.deepEqual([want.previous.count, want.previous.amount], [1, '1000.00']);
  const kpi = await kit.readKpi(env.cX, 'legal.contracts_signed');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'legal.contracts_signed']);
  assert.equal(Number(kpi.value), want.count);
  assert.equal(await money(env.cX, 'legal.contracts_signed', 'valor_brl'), want.amount);
  assert.deepEqual([await dim(env.cX, 'legal.contracts_signed', 'anterior_qtd'), await money(env.cX, 'legal.contracts_signed', 'anterior_valor_brl')], ['1', '1000.00']);
  assert.equal(await dim(env.cX, 'legal.contracts_signed', 'tipo:LEASE:qtd'), '2');
  assert.equal(await money(env.cX, 'legal.contracts_signed', 'tipo:LEASE:valor_brl'), '2500.00');
  assert.equal(await money(env.cX, 'legal.contracts_signed', 'tipo:SALE:valor_brl'), '480000.00');
});

test('m9d710 o exemplo do livro: 2 contratos (480.000,00 e 2.400,00) dão 2 e 482.400,00', async () => {
  const t = env.cY;
  await sc.contract(env, t, { type: 'SALE', total: '480000.00', signedAt: sc.at('28', '10:00:00') });
  await sc.contract(env, t, { type: 'LEASE', total: '2400.00', signedAt: sc.at('27', '20:00:00') });
  await kit.rebuild(t);
  const r = (await kit.kpis(t)).cmd.kpis['legal.contracts_signed'];
  assert.deepEqual([r.status, r.value, r.details.amount], ['OK', '2', '482400.00']);
});

test('m9d710 reproduz crm.opportunities_won a partir dos registros-fonte', async () => {
  const want = await oracle.opportunitiesFromSource(env, env.cX, WINDOW);
  assert.deepEqual([want.count, want.amount, want.withoutValue, want.previous.count, want.previous.amount], [3, '510000.00', 1, 1, '77000.00']);
  const kpi = await kit.readKpi(env.cX, 'crm.opportunities_won');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version], ['OK', 'COUNT', 1]);
  assert.equal(Number(kpi.value), want.count);
  assert.equal(await money(env.cX, 'crm.opportunities_won', 'valor_brl'), want.amount);
  assert.equal(await dim(env.cX, 'crm.opportunities_won', 'sem_valor_qtd'), '1');
  assert.equal(await dim(env.cX, 'crm.opportunities_won', `corretor:${sc.BROKER_A}:qtd`), '2');
  assert.equal(await money(env.cX, 'crm.opportunities_won', `corretor:${sc.BROKER_A}:valor_brl`), '510000.00');
  assert.equal(await dim(env.cX, 'crm.opportunities_won', 'origem:SITE:qtd'), '2');
  assert.equal(await money(env.cX, 'crm.opportunities_won', 'origem:INDICACAO:valor_brl'), '210000.00');
});

test('m9d710 oportunidade ganha sem proposta aceita entra em withoutValue', async () => {
  const r = (await kit.kpis(env.cX)).cmd.kpis['crm.opportunities_won'];
  assert.deepEqual([r.status, r.value, r.details.withoutValue, r.details.amount], ['OK', '3', '1', '510000.00']);
  const [rows] = await env.admin.query("SELECT count(*)::int AS n FROM analytics.rm_command_events WHERE company_id = :c AND kind = 'OPPORTUNITY_WON' AND amount IS NULL", { replacements: { c: env.cX.companyId } });
  assert.equal(rows[0].n, 1, 'a linha da ganha com proposta só ENVIADA tem valor nulo (as demais têm proposta aceita)');
});

test('m9d710 reproduz fin.payments_settled_relevant a partir dos registros-fonte', async () => {
  const want = await oracle.paymentsFromSource(env, env.cX, WINDOW);
  assert.deepEqual([want.count, want.amount, want.thirdParty.count, want.thirdParty.amount, want.previous.count, want.previous.amount], [2, '35000.00', 1, '50000.00', 1, '15000.00']);
  const kpi = await kit.readKpi(env.cX, 'fin.payments_settled_relevant');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version], ['OK', 'COUNT', 1]);
  assert.equal(Number(kpi.value), want.count);
  assert.equal(await money(env.cX, 'fin.payments_settled_relevant', 'valor_brl'), want.amount);
  assert.equal(await money(env.cX, 'fin.payments_settled_relevant', `conta:${sc.ACCOUNT_A}:valor_brl`), '10000.00');
  assert.equal(await money(env.cX, 'fin.payments_settled_relevant', `conta:${sc.ACCOUNT_B}:valor_brl`), '25000.00');
});

test('m9d710 limiar valor_relevante é inclusivo e lido do parâmetro', async () => {
  const t = env.cY;
  await sc.pagamentos(env, t);
  await kit.rebuild(t);
  const own = async () => { const r = (await kit.kpis(t)).cmd.kpis['fin.payments_settled_relevant']; return [r.value, r.details.amount]; };
  assert.deepEqual(await own(), ['2', '35000.00'], 'padrão R$ 10.000,00: 9.999,99 fica de fora e 10.000,00 entra');
  await kit.setSetting(env, t, 'analytics.centro.valor_relevante', 'R$ 9.999,99');
  assert.deepEqual(await own(), ['3', '44999.99'], 'o administrador baixou o limiar: o de 9.999,99 entra (inclusivo)');
  await kit.setSetting(env, t, 'analytics.centro.valor_relevante', '25000.01');
  assert.deepEqual(await own(), ['0', '0.00'], 'acima de todos');
  await kit.setSetting(env, t, 'analytics.centro.valor_relevante', 'R$ 10.000,00');
});

test('m9d710 terceiros não somam ao próprio', async () => {
  const k = (await kit.kpis(env.cX)).cmd.kpis['fin.payments_settled_relevant'];
  assert.equal(k.details.amount, '35000.00', 'os 50.000,00 de terceiros não entram na soma própria');
  assert.deepEqual([k.details.thirdParty.count, k.details.thirdParty.amount], ['1', '50000.00']);
  assert.equal(await money(env.cX, 'fin.payments_settled_relevant', 'terceiros_valor_brl'), '50000.00');
  const [rows] = await env.admin.query("SELECT count(*)::int AS n FROM analytics.rm_command_events WHERE company_id = :c AND kind = 'PAYMENT_SETTLED' AND is_third_party", { replacements: { c: env.cX.companyId } });
  assert.equal(rows[0].n, 1, 'a linha de terceiros fica marcada no read model');
});

test('m9d710 janela usa calendário de São Paulo', async () => {
  const [rows] = await env.admin.query(
    "SELECT occurred_at, occurred_date::text AS day FROM analytics.rm_command_events WHERE company_id = :c AND kind = 'CONTRACT_SIGNED' AND amount = 100.00", { replacements: { c: env.cX.companyId } }
  );
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].occurred_at).toISOString(), '2026-10-28T02:30:00.000Z');
  assert.equal(rows[0].day, '2026-10-27', 'assinatura às 23:30 de São Paulo cai no dia 27 de São Paulo, não no 28 de UTC');
  const past = oracle.windowOfPastDay('2026-10-27', 24);
  const want = await oracle.contractsFromSource(env, env.cX, past);
  const got = (await kit.kpis(env.cX, '2026-10-27')).cmd.kpis['legal.contracts_signed'];
  assert.deepEqual([got.value, got.details.amount], [String(want.count), want.amount]);
  assert.deepEqual([got.value, got.details.amount], ['3', '3500.00'], 'o dia 27 de São Paulo: 2.400,00 (17:00), 1.000,00 (11:59) e 100,00 (23:30)');
});
